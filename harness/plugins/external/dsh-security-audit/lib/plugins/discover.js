/**
 * scan_plugins 检查器（设计 §7.2）。
 * 数据来源：profile package.json 的 dsh.profile.bundles + cordis.patch.yml 行
 * + node_modules 已解析包 + 可选源码能力扫描（includeSourceScan）。
 * 与 plugin-check 的边界：本模块只做来源/权限/秘密/危险能力/加载边界，
 * 不复制结构合规规则，不通过模型工具间接获取结果。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LIMITS } from '../limits.js';
import { lstatSafe, PathEscapeError, throwIfAborted, throwIfDeadlineExceeded } from '../paths.js';
import { redactPath, safeErrorMessage } from '../redact.js';
import { RULE_BY_CODE } from '../rules.js';
import { classifySource, installScripts, resolvePluginLocation, } from './package.js';
import { parsePatchRows } from './patch.js';
import { capabilityFindings, findSecretLikeFiles, scanSourceCapabilities, } from './source-capabilities.js';
async function discoverProfiles(root, profileFilter, signal) {
    const profiles = [{ name: '(root)', dir: root }];
    const profilesDir = path.join(root, 'profiles');
    const stat = await lstatSafe(profilesDir);
    if (stat === null || !stat.isDirectory())
        return profiles;
    let entries;
    try {
        entries = await fs.readdir(profilesDir, { withFileTypes: true });
    }
    catch {
        return profiles;
    }
    for (const e of entries) {
        throwIfAborted(signal);
        if (profileFilter !== undefined && e.name !== profileFilter)
            continue;
        const dir = path.join(profilesDir, e.name);
        const s = await lstatSafe(dir);
        if (s === null || !s.isDirectory() || s.isSymbolicLink())
            continue;
        profiles.push({ name: e.name, dir });
    }
    return profiles;
}
async function readJsonIfExists(dir, file) {
    try {
        const text = await fs.readFile(path.join(dir, file), 'utf8');
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
async function collectDecls(_ctx, profile, state) {
    const decls = [];
    const pushDecl = (d) => {
        if (state.count >= LIMITS.plugins) {
            state.truncated = true;
            return;
        }
        state.count++;
        decls.push(d);
    };
    // bundle 声明
    const pkgJson = await readJsonIfExists(profile.dir, 'package.json');
    const dsh = pkgJson?.['dsh']?.profile;
    if (dsh && Array.isArray(dsh.bundles)) {
        for (const raw of dsh.bundles) {
            if (typeof raw !== 'string' || raw === '')
                continue;
            pushDecl({ id: raw, name: raw, profile: profile.name, origin: 'bundle', resolved: false });
        }
    }
    // patch 行
    const patchText = await fs.readFile(path.join(profile.dir, 'cordis.patch.yml'), 'utf8').catch(() => null);
    if (patchText !== null) {
        const { rows } = parsePatchRows(patchText);
        for (const row of rows) {
            if (row.name === undefined && row.id === undefined)
                continue;
            pushDecl({
                id: row.id ?? row.name ?? '',
                name: row.name ?? row.id ?? '',
                ...(row.source !== undefined ? { source: row.source } : {}),
                profile: profile.name,
                origin: 'patch',
                line: row.line,
                resolved: false,
            });
        }
    }
    return decls;
}
/** 轻量检查：main entry 的相对 import 是否被 package files/exports 覆盖。 */
async function checkUndeclaredRuntimeFiles(ctx, pkgName, location, checks, findings) {
    const pkg = location.pkg;
    const files = pkg.files;
    if (files === undefined || files.length === 0) {
        checks.push({ code: 'undeclared-runtime-file', state: 'pass', subject: `plugin:${pkgName}`, severity: 'info' });
        return;
    }
    const exportsMap = pkg.exports;
    const entryRel = pkg.main ?? 'index.js';
    const entry = path.join(location.dir, entryRel);
    let text;
    try {
        text = await fs.readFile(entry, 'utf8');
    }
    catch {
        checks.push({ code: 'undeclared-runtime-file', state: 'skipped', subject: `plugin:${pkgName}`, severity: 'info', skipReason: 'not-applicable', reason: 'entry file not found' });
        return;
    }
    const importRe = /(?:from\s+|require\s*\(\s*|import\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;
    const referenced = [];
    for (const m of text.matchAll(importRe))
        referenced.push(m[1]);
    const covered = (rel) => {
        const norm = rel.replace(/\\/g, '/').replace(/^\.\//, '');
        for (const f of files) {
            const fn = f.replace(/\\/g, '/').replace(/\/$/, '');
            if (fn === norm)
                return true;
            if (fn.endsWith('/*')) {
                const prefix = fn.slice(0, -1);
                if (norm.startsWith(prefix))
                    return true;
            }
            if (norm.startsWith(fn + '/'))
                return true;
        }
        return false;
    };
    const declaredKeys = exportsMap !== undefined && typeof exportsMap === 'object'
        ? Object.keys(exportsMap)
        : [];
    let undeclared = 0;
    const entryDir = path.dirname(entry);
    for (const rel of referenced) {
        const abs = path.resolve(entryDir, rel);
        const stat = await lstatSafe(abs);
        if (stat === null || !stat.isFile())
            continue;
        const relToPkg = path.relative(location.dir, abs).replace(/\\/g, '/');
        if (covered(relToPkg))
            continue;
        const exportKey = rel.startsWith('.') ? rel : `./${rel.replace(/^\.\//, '')}`;
        if (declaredKeys.includes(exportKey))
            continue;
        undeclared++;
        findings.push({
            severity: 'medium',
            code: 'undeclared-runtime-file',
            category: 'plugins',
            subject: `plugin:${pkgName}:${relToPkg}`,
            evidence: { path: redactPath(abs, ctx.root, ctx.home), redacted: false },
            exposure: 'runtime file referenced by the entry is not covered by package files/exports and may not ship in the published package',
            recommendation: 'add the file to package files or expose it via exports',
            confidence: 'medium',
            ruleVersion: 1,
        });
    }
    checks.push({
        code: 'undeclared-runtime-file',
        state: undeclared === 0 ? 'pass' : 'finding',
        subject: `plugin:${pkgName}`,
        severity: undeclared === 0 ? 'info' : 'medium',
    });
}
export async function scanPlugins(ctx) {
    const checks = [];
    const findings = [];
    const state = { count: 0, truncated: false };
    const sourceState = { files: 0, bytes: 0, truncated: false };
    const seenIds = new Map(); // id → first subject
    const profiles = await discoverProfiles(ctx.root, ctx.profile, ctx.signal);
    for (const profile of profiles) {
        throwIfAborted(ctx.signal);
        throwIfDeadlineExceeded(ctx.deadline, ctx.signal);
        const decls = await collectDecls(ctx, profile, state);
        for (const decl of decls) {
            throwIfAborted(ctx.signal);
            throwIfDeadlineExceeded(ctx.deadline, ctx.signal);
            const subject = `profile:${decl.profile}:${decl.id}`;
            const candidates = [ctx.root, profile.dir];
            // duplicate-row-id
            const prev = seenIds.get(decl.id);
            if (prev !== undefined && prev !== subject) {
                findings.push({
                    severity: 'medium',
                    code: 'duplicate-row-id',
                    category: 'plugins',
                    subject,
                    evidence: { value: decl.id, redacted: false },
                    exposure: 'duplicate plugin row id across profiles; loading order may be ambiguous',
                    recommendation: 'make row ids unique across the profile composition',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'duplicate-row-id', state: 'finding', subject, severity: 'medium' });
            }
            else {
                seenIds.set(decl.id, subject);
            }
            // 来源分类
            const sourceMeta = classifySource(decl.source);
            if (sourceMeta.kind === 'git' && sourceMeta.pinned === false) {
                findings.push({
                    severity: 'medium',
                    code: 'plugin-unpinned-git',
                    category: 'plugins',
                    subject,
                    ...(decl.source !== undefined ? { evidence: { value: decl.source.slice(0, 40), redacted: true } } : {}),
                    exposure: 'git source is not pinned to a commit/tag; supply-chain drift risk',
                    recommendation: 'pin the git source to an explicit commit or tag',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'plugin-unpinned-git', state: 'finding', subject, severity: 'medium' });
            }
            if (sourceMeta.kind === 'link' || sourceMeta.kind === 'workspace') {
                findings.push({
                    severity: 'medium',
                    code: 'plugin-workspace-runtime',
                    category: 'plugins',
                    subject,
                    exposure: 'runtime depends on a sibling checkout / workspace link; environment-specific and harder to audit',
                    recommendation: 'use a pinned published package or a pinned git commit for runtime dependencies',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'plugin-workspace-runtime', state: 'finding', subject, severity: 'medium' });
            }
            // 解析位置
            let location = null;
            let escapeError;
            try {
                location = await resolvePluginLocation(decl.name, decl.source, candidates, ctx.signal);
            }
            catch (error) {
                if (error instanceof PathEscapeError)
                    escapeError = error.message;
                else if (error instanceof Error) {
                    checks.push({ code: 'plugin-unresolved', state: 'error', subject, severity: 'info', reason: safeErrorMessage(error, ctx.root, ctx.home) });
                }
            }
            if (location !== null)
                decl.location = location;
            decl.resolved = location !== null;
            if (escapeError !== undefined)
                decl.escapeError = escapeError;
            if (escapeError !== undefined) {
                findings.push({
                    severity: 'high',
                    code: 'plugin-path-outside-root',
                    category: 'plugins',
                    subject,
                    exposure: 'plugin entry escapes the allowed root (symlink or path outside $DSH_HOME)',
                    recommendation: 'reinstall the plugin inside the profile bundle; remove symlinked entries',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'plugin-path-outside-root', state: 'finding', subject, severity: 'high', reason: safeErrorMessage(escapeError, ctx.root, ctx.home) });
                continue;
            }
            if (location === null) {
                findings.push({
                    severity: 'high',
                    code: 'plugin-unresolved',
                    category: 'plugins',
                    subject,
                    exposure: 'declared plugin could not be resolved in node_modules or via source path',
                    recommendation: 'install the package or fix the source reference',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'plugin-unresolved', state: 'finding', subject, severity: 'high' });
                continue;
            }
            checks.push({ code: 'plugin-unresolved', state: 'pass', subject, severity: 'info' });
            // package name mismatch
            const pkgName = location.pkg.name;
            if (pkgName !== undefined && decl.name !== '' && pkgName !== decl.name) {
                findings.push({
                    severity: 'high',
                    code: 'plugin-package-mismatch',
                    category: 'plugins',
                    subject,
                    evidence: { value: `${decl.name} vs ${pkgName}`, redacted: false },
                    exposure: 'patch row name does not match the resolved package name; patch may target the wrong package',
                    recommendation: 'align the patch row name with the package name',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'plugin-package-mismatch', state: 'finding', subject, severity: 'high' });
            }
            else {
                checks.push({ code: 'plugin-package-mismatch', state: 'pass', subject, severity: 'info' });
            }
            // install scripts
            const scripts = installScripts(location.pkg);
            if (scripts.length > 0) {
                findings.push({
                    severity: 'medium',
                    code: 'install-script',
                    category: 'plugins',
                    subject,
                    evidence: { value: scripts.join(','), redacted: false },
                    exposure: 'package declares lifecycle install scripts that execute during install',
                    recommendation: 'review the scripts; prefer packages without install-time code execution',
                    confidence: 'high',
                    ruleVersion: 1,
                });
                checks.push({ code: 'install-script', state: 'finding', subject, severity: 'medium' });
            }
            else {
                checks.push({ code: 'install-script', state: 'pass', subject, severity: 'info' });
            }
            // secret-like files
            const secretLike = await findSecretLikeFiles(location.dir, { signal: ctx.signal, deadline: ctx.deadline });
            if (secretLike.length > 0) {
                for (const f of secretLike.slice(0, 5)) {
                    findings.push({
                        severity: 'high',
                        code: 'secret-like-file',
                        category: 'plugins',
                        subject: `plugin:${pkgName ?? decl.name}:${path.relative(ctx.root, f).replace(/\\/g, '/')}`,
                        evidence: { path: redactPath(f, ctx.root, ctx.home), redacted: true },
                        exposure: 'plugin package ships a file that looks like a secret store (.env/key/pem)',
                        recommendation: 'verify the file is a template, not a real secret; exclude it from the published package',
                        confidence: 'medium',
                        ruleVersion: 1,
                    });
                }
                checks.push({ code: 'secret-like-file', state: 'finding', subject, severity: 'high' });
            }
            else {
                checks.push({ code: 'secret-like-file', state: 'pass', subject, severity: 'info' });
            }
            // undeclared runtime files
            await checkUndeclaredRuntimeFiles(ctx, pkgName ?? decl.name, location, checks, findings);
            // 可选源码能力扫描
            if (ctx.includeSourceScan) {
                const { hits } = await scanSourceCapabilities(location.dir, { signal: ctx.signal, deadline: ctx.deadline, state: sourceState });
                if (hits.length === 0) {
                    checks.push({ code: 'dynamic-code-execution', state: 'pass', subject, severity: 'info' });
                    checks.push({ code: 'process-execution-capability', state: 'pass', subject, severity: 'info' });
                    checks.push({ code: 'network-capability', state: 'pass', subject, severity: 'info' });
                }
                else {
                    findings.push(...capabilityFindings(ctx, pkgName ?? decl.name, hits));
                    const codes = new Set(hits.map((h) => h.code));
                    for (const code of ['dynamic-code-execution', 'process-execution-capability', 'network-capability']) {
                        checks.push({ code, state: codes.has(code) ? 'finding' : 'pass', subject, severity: codes.has(code) ? (RULE_BY_CODE.get(code)?.severity ?? 'medium') : 'info' });
                    }
                }
            }
            else {
                checks.push({ code: 'dynamic-code-execution', state: 'skipped', subject, severity: 'info', skipReason: 'config', reason: 'source scan disabled (includeSourceScan=false)' });
                checks.push({ code: 'process-execution-capability', state: 'skipped', subject, severity: 'info', skipReason: 'config', reason: 'source scan disabled (includeSourceScan=false)' });
                checks.push({ code: 'network-capability', state: 'skipped', subject, severity: 'info', skipReason: 'config', reason: 'source scan disabled (includeSourceScan=false)' });
            }
        }
    }
    if (state.count === 0) {
        checks.push({ code: 'plugin-unresolved', state: 'skipped', subject: '(no plugins declared)', severity: 'info', skipReason: 'not-applicable', reason: 'no bundles or patch rows found' });
    }
    return { checks, findings, truncated: state.truncated || sourceState.truncated };
}
export { parsePatchRows } from './patch.js';
