/**
 * scan_config 检查器（设计 §7.1 规则）。
 * 只读：读取后不修改；行级秘密扫描 + 有限安全解析 + 权限适配。
 */
import * as path from 'node:path';
import { LIMITS } from '../limits.js';
import { assertWithin, readFileCapped, throwIfAborted, throwIfDeadlineExceeded, } from '../paths.js';
import { displayUrl, redactPath, safeErrorMessage, scanSecrets } from '../redact.js';
import { RULE_BY_CODE } from '../rules.js';
import { discoverConfigFiles } from './discover.js';
import { parseSafeByKind, scalarValues } from './parse-safe.js';
import { checkFilePermissions } from '../platform/permissions.js';
const ENV_PLACEHOLDER_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const URL_KEY_RE = /url|endpoint|discovery|proxy|base|host|link|root|patch/i;
const CREDENTIAL_TARGET_KEY_RE = /credential|token|api[_-]?key|secret|password|auth/i;
function makeFinding(_ctx, code, subject, t) {
    const rule = RULE_BY_CODE.get(code);
    return {
        severity: t.severity ?? rule?.severity ?? 'info',
        code,
        category: rule?.category ?? 'config',
        subject,
        ...(t.evidence !== undefined ? { evidence: t.evidence } : {}),
        exposure: t.exposure,
        recommendation: t.recommendation,
        confidence: t.confidence,
        ruleVersion: rule?.ruleVersion ?? 1,
    };
}
/** 检查单个非 credentials 配置文件中的秘密（secret-in-settings / inline-private-key）。 */
function checkSecrets(ctx, file, text, checks, findings) {
    const rel = file.rel;
    const redactedPath = redactPath(file.path, ctx.root, ctx.home);
    const hits = scanSecrets(text);
    if (hits.length === 0) {
        checks.push({ code: 'secret-in-settings', state: 'pass', subject: rel, severity: 'info' });
        checks.push({ code: 'inline-private-key', state: 'pass', subject: rel, severity: 'info' });
        return;
    }
    for (const hit of hits) {
        const evidence = ctx.redactor.secretEvidence(hit, redactedPath);
        if (hit.kind === 'private-key') {
            findings.push(makeFinding(ctx, 'inline-private-key', rel, {
                severity: 'critical',
                exposure: 'private key material (PEM header) found in a non-credentials file',
                recommendation: 'move key material into a protected credentials store and rotate the key',
                confidence: 'high',
                evidence,
            }));
        }
        else {
            findings.push(makeFinding(ctx, 'secret-in-settings', rel, {
                exposure: `secret-like value (${hit.kind}) found in a non-credentials settings file`,
                recommendation: 'move secrets to the credentials store; verify the value is not a real credential',
                confidence: hit.kind === 'api-key' ? 'high' : 'medium',
                evidence,
            }));
        }
    }
    const lastEvidence = findings[findings.length - 1]?.evidence;
    checks.push({ code: 'secret-in-settings', state: 'finding', subject: rel, severity: 'high', ...(lastEvidence !== undefined ? { evidence: lastEvidence } : {}) });
}
/** profile-path-outside-root：link/patch/root 字段指向预期根之外。 */
function checkPathFields(ctx, file, data, checks, findings) {
    let flagged = false;
    for (const [k, v] of scalarValues(data)) {
        if (typeof v !== 'string')
            continue;
        if (!/(^|\.)(link|patch|root|path)$/i.test(k) && !/^link$|^patch$|^root$/i.test(k))
            continue;
        if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('/'))
            continue; // URL 或绝对路径另行处理
        if (v.startsWith('.')) {
            const resolved = path.resolve(path.dirname(file.path), v);
            try {
                assertWithin(ctx.root, resolved);
            }
            catch {
                flagged = true;
                findings.push(makeFinding(ctx, 'profile-path-outside-root', `${file.rel}:${k}`, {
                    exposure: 'configured link/patch/root path resolves outside the DSH root',
                    recommendation: 'point the entry back inside $DSH_HOME or remove the field',
                    confidence: 'high',
                    evidence: { path: redactPath(file.path, ctx.root, ctx.home), value: v, redacted: false },
                }));
            }
        }
    }
    if (!flagged) {
        checks.push({ code: 'profile-path-outside-root', state: 'pass', subject: file.rel, severity: 'info' });
    }
}
/** 凭据相关 URL 目标检查：external-credential-target / plaintext-external-endpoint。 */
function checkCredentialTargets(ctx, file, data, text, checks, findings) {
    const redactedPath = redactPath(file.path, ctx.root, ctx.home);
    const subjects = [];
    for (const [k, v] of scalarValues(data)) {
        if (typeof v !== 'string')
            continue;
        if (!CREDENTIAL_TARGET_KEY_RE.test(k) && !URL_KEY_RE.test(k))
            continue;
        if (!/^https?:\/\//i.test(v))
            continue;
        subjects.push({ key: k, value: v });
    }
    // 行级兜底：解析失败时也能发现 URL
    if (subjects.length === 0) {
        for (const m of text.matchAll(/https?:\/\/[^\s"')\]]+/g)) {
            const s = m[0];
            if (/(credential|token|api[_-]?key|secret|password|auth)/i.test(s.slice(0, 64))) {
                subjects.push({ key: '(line-scan)', value: s });
            }
        }
    }
    const seen = new Set();
    for (const { key, value } of subjects) {
        if (seen.has(value))
            continue;
        seen.add(value);
        const u = new URL(value);
        const host = u.hostname.toLowerCase();
        const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host) || host === '[::1]';
        const hasUserinfo = u.username !== '' || u.password !== '';
        const plaintextExternal = u.protocol === 'http:' && !loopback;
        // credentials 文件中的任何外部 URL 都可能携带凭据；其它文件要求 key 语义贴近凭据
        const credentialContext = file.kind === 'credentials' || /credential|token|api[_-]?key|secret|password|auth/i.test(key);
        if (hasUserinfo || (!loopback && credentialContext)) {
            findings.push(makeFinding(ctx, 'external-credential-target', `${file.rel}:${key}`, {
                exposure: hasUserinfo
                    ? 'URL embeds userinfo (possible credential leak in config)'
                    : 'credential-related URL targets a non-loopback endpoint',
                recommendation: 'use a credential store reference and verify the endpoint allowlist',
                confidence: 'high',
                evidence: { path: redactedPath, value: displayUrl(value), redacted: true },
            }));
        }
        if (plaintextExternal) {
            findings.push(makeFinding(ctx, 'plaintext-external-endpoint', `${file.rel}:${key}`, {
                exposure: 'credential-related endpoint uses plaintext HTTP to a non-local target',
                recommendation: 'switch to HTTPS and verify the endpoint allowlist',
                confidence: 'high',
                evidence: { path: redactedPath, value: displayUrl(value), redacted: true },
            }));
        }
    }
    if (subjects.length === 0) {
        checks.push({ code: 'external-credential-target', state: 'pass', subject: file.rel, severity: 'info' });
        checks.push({ code: 'plaintext-external-endpoint', state: 'pass', subject: file.rel, severity: 'info' });
    }
}
/** env-expansion-missing：配置引用的 ${VAR} 在环境中缺失。 */
function checkEnvExpansions(ctx, text, rel, checks, findings) {
    const missing = new Set();
    for (const m of text.matchAll(ENV_PLACEHOLDER_RE)) {
        const name = m[1];
        if (!(name in ctx.env))
            missing.add(name);
    }
    for (const name of [...missing].sort()) {
        findings.push(makeFinding(ctx, 'env-expansion-missing', `env:${name}`, {
            exposure: `required environment variable ${name} referenced by ${rel} is not set`,
            recommendation: 'set the variable or provide a safe fallback in configuration',
            confidence: 'medium',
            evidence: { value: `\${${name}}`, redacted: false },
        }));
    }
    const reason = missing.size === 0 ? undefined : `${missing.size} missing variable(s)`;
    checks.push({
        code: 'env-expansion-missing',
        state: missing.size === 0 ? 'pass' : 'finding',
        subject: rel,
        severity: missing.size === 0 ? 'info' : 'medium',
        ...(reason !== undefined ? { reason } : {}),
    });
}
/** 凭据文件权限检查（平台适配：win32 → skipped）。 */
async function checkCredentialsPermissions(ctx, file, checks) {
    const result = await checkFilePermissions(file.path, { platform: ctx.platform });
    const rel = file.rel;
    if (!result.supported) {
        checks.push({ code: 'credential-file-permissions', state: 'skipped', subject: rel, severity: 'info', skipReason: 'platform', ...(result.reason !== undefined ? { reason: result.reason } : {}) });
        return;
    }
    if (result.unreadable) {
        checks.push({ code: 'credential-file-permissions', state: 'skipped', subject: rel, severity: 'info', skipReason: 'permission', reason: result.unreadable });
        return;
    }
    if (result.issues.length === 0) {
        checks.push({ code: 'credential-file-permissions', state: 'pass', subject: rel, severity: 'info' });
        return;
    }
    const worst = result.issues.some((i) => i.severity === 'high') ? 'high' : 'medium';
    checks.push({ code: 'credential-file-permissions', state: 'finding', subject: rel, severity: worst, reason: result.issues.map((i) => i.detail).join('; ') });
}
export async function scanConfig(ctx) {
    const checks = [];
    const findings = [];
    const discovery = await discoverConfigFiles(ctx.root, { ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}), signal: ctx.signal, deadline: ctx.deadline });
    for (const file of discovery.files) {
        throwIfAborted(ctx.signal);
        throwIfDeadlineExceeded(ctx.deadline, ctx.signal);
        // package.json / cordis.patch.yml 由 scan_plugins 负责，config 内容扫描跳过
        if (file.kind === 'package' || file.kind === 'patch')
            continue;
        const read = await readFileCapped(file.path, LIMITS.configFileBytes, ctx.signal);
        if (read.kind === 'missing')
            continue;
        if (read.kind === 'too-large') {
            checks.push({ code: 'unknown-config-format', state: 'skipped', subject: file.rel, severity: 'info', skipReason: 'budget', reason: `file exceeds ${LIMITS.configFileBytes} bytes` });
            continue;
        }
        if (read.kind === 'error') {
            checks.push({ code: 'unknown-config-format', state: 'error', subject: file.rel, severity: 'info', reason: safeErrorMessage(read.message, ctx.root, ctx.home) });
            continue;
        }
        const text = read.buf.toString('utf8');
        const isCredentials = file.kind === 'credentials';
        if (isCredentials) {
            // 凭据文件不触发 secret-in-settings/inline-private-key（秘密存在是预期）
            await checkCredentialsPermissions(ctx, file, checks);
            const parsed = parseSafeByKind(text, file.kind);
            if (parsed.ok && parsed.data) {
                checkCredentialTargets(ctx, file, parsed.data, text, checks, findings);
            }
            else {
                checkCredentialTargets(ctx, file, {}, text, checks, findings);
            }
            continue;
        }
        // 非 credentials 配置文件：秘密扫描 + 解析
        checkSecrets(ctx, file, text, checks, findings);
        checkEnvExpansions(ctx, text, file.rel, checks, findings);
        const parsed = parseSafeByKind(text, file.kind);
        if (parsed.ok && parsed.data) {
            checkPathFields(ctx, file, parsed.data, checks, findings);
            checkCredentialTargets(ctx, file, parsed.data, text, checks, findings);
        }
        else {
            // 无法可信解析 → 降级行级扫描（秘密/URL 已覆盖），标记 confidence
            checks.push({ code: 'unknown-config-format', state: 'finding', subject: file.rel, severity: 'info', reason: parsed.reason ?? 'parse failed' });
            findings.push(makeFinding(ctx, 'unknown-config-format', file.rel, {
                exposure: 'config file exists but could not be parsed safely; only line-level checks ran',
                recommendation: 'normalize the file format or fix the parse error',
                confidence: 'low',
                evidence: { path: redactPath(file.path, ctx.root, ctx.home), redacted: true },
            }));
            checkPathFields(ctx, file, {}, checks, findings);
        }
    }
    // 有 credentials 文件但无任何检查 → 兜底 pass 不需要；无文件时给 pass 提示
    if (discovery.files.length === 0) {
        checks.push({ code: 'secret-in-settings', state: 'skipped', subject: '(no config files)', severity: 'info', skipReason: 'not-applicable', reason: 'no config files found under root' });
    }
    return { checks, findings, truncated: discovery.truncated };
}
