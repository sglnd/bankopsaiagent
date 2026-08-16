/**
 * action 调度、预算、汇总（设计 §5 报告模型 / §9 输出与资源限制）。
 *
 * - report 内部建立 action 级 deadline，在每个子扫描器之间检查；
 * - 超时/取消返回工具错误（抛异常），不得返回部分结果并伪称完整；
 * - 单文件大小在读取前通过 lstat 限制；
 * - findings/checks 有上限，超出置 truncated；
 * - verdict：riskVerdict + coverageVerdict 双维度（§5.3）。
 */
import { homedir } from 'node:os';
import { LIMITS } from './limits.js';
import { AuditAbortedError, AuditTimeoutError, isWithinPath, realpathSafe, resolveDshHome, throwIfAborted, throwIfDeadlineExceeded, } from './paths.js';
import { Redactor, redactPath, safeErrorMessage } from './redact.js';
import { RULE_BY_CODE, RULES, SEVERITY_RANK } from './rules.js';
import { scanConfig } from './config/checks.js';
import { scanPlugins } from './plugins/discover.js';
import { scanSessions } from './sessions/checks.js';
import { scanNetwork } from './network/checks.js';
const PROFILE_RE = /^[A-Za-z0-9._-]{1,64}$/;
const ACTIONS = ['scan_config', 'scan_plugins', 'scan_sessions', 'scan_network', 'report', 'rules'];
export class AuditArgsError extends Error {
    name = 'AuditArgsError';
}
export async function buildRulesOutput(platform = process.platform) {
    const rules = RULES.map((r) => ({
        code: r.code,
        category: r.category,
        severity: r.severity,
        description: r.description,
        platforms: r.platforms,
        ruleVersion: r.ruleVersion,
        critical: r.critical,
    }));
    return { tool: 'security_audit', action: 'rules', platform, rules };
}
async function buildContext(params, opts) {
    const env = opts.env ?? process.env;
    const home = opts.home ?? homedir();
    const platform = opts.platform ?? process.platform;
    const fixedRootRaw = opts.fixedRoot ?? resolveDshHome(env);
    const fixedRoot = (await realpathSafe(fixedRootRaw)) ?? fixedRootRaw;
    const allowedRootsRaw = opts.allowedRoots ?? [];
    const allowedRoots = [];
    for (const r of allowedRootsRaw) {
        const real = await realpathSafe(r);
        if (real !== null)
            allowedRoots.push(real);
    }
    let root = fixedRoot;
    if (params.root !== undefined && params.root !== '') {
        const real = await realpathSafe(params.root);
        if (real === null)
            throw new AuditArgsError('security_audit: provided root does not exist or cannot be resolved');
        if (real !== fixedRoot && !allowedRoots.includes(real)) {
            throw new AuditArgsError('security_audit: provided root is not the fixed $DSH_HOME and not in allowedRoots');
        }
        root = real;
    }
    if (params.profile !== undefined && !PROFILE_RE.test(params.profile)) {
        throw new AuditArgsError('security_audit: profile must be a simple name matching ^[A-Za-z0-9._-]{1,64}$');
    }
    const action = (params.action === 'rules' ? 'scan_config' : params.action);
    const deadline = Date.now() + (action === 'report' ? LIMITS.reportTimeoutMs : LIMITS.actionTimeoutMs);
    return {
        action,
        root,
        fixedRoot,
        home,
        ...(params.profile !== undefined ? { profile: params.profile } : {}),
        strict: params.strict === true,
        detail: params.detail !== false,
        includeSourceScan: params.includeSourceScan === true,
        signal: opts.signal ?? new AbortController().signal,
        env,
        allowedRoots,
        allowedEndpoints: opts.allowedEndpoints ?? [],
        deadline,
        platform,
        redactor: new Redactor(),
    };
}
// ---------------------------------------------------------------------------
// verdict / summary / ordering（纯函数，可单测）
// ---------------------------------------------------------------------------
export function computeRiskVerdict(findings, strict) {
    if (findings.some((f) => f.severity === 'critical' || f.severity === 'high'))
        return 'fail';
    if (findings.some((f) => f.severity === 'medium'))
        return strict ? 'fail' : 'warning';
    if (findings.some((f) => f.severity === 'low'))
        return 'warning';
    return 'pass';
}
const COVERAGE_SKIP_REASONS = new Set(['platform', 'permission']);
export function computeCoverageVerdict(checks) {
    for (const c of checks) {
        // 扫描器自身失败（internal-error）视为关键覆盖不全
        if (c.code === 'internal-error' && c.state === 'error')
            return 'incomplete';
        const rule = RULE_BY_CODE.get(c.code);
        if (rule === undefined || !rule.critical)
            continue;
        if (c.state === 'error')
            return 'incomplete';
        if (c.state === 'skipped' && c.skipReason !== undefined && COVERAGE_SKIP_REASONS.has(c.skipReason)) {
            return 'incomplete';
        }
    }
    return 'complete';
}
export function computeVerdict(risk, coverage) {
    if (risk === 'fail')
        return 'fail';
    if (coverage === 'incomplete')
        return 'incomplete';
    if (risk === 'warning')
        return 'warning';
    return 'pass';
}
export function summarize(findings, checks) {
    const summary = { critical: 0, high: 0, medium: 0, low: 0, info: 0, passed: 0, skipped: 0, errors: 0 };
    for (const f of findings) {
        summary[f.severity]++;
    }
    for (const c of checks) {
        if (c.state === 'pass')
            summary.passed++;
        else if (c.state === 'skipped')
            summary.skipped++;
        else if (c.state === 'error')
            summary.errors++;
    }
    return summary;
}
const SEVERITY_ORDER = SEVERITY_RANK;
export function sortFindings(findings) {
    return [...findings].sort((a, b) => {
        return (SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
            a.category.localeCompare(b.category) ||
            a.code.localeCompare(b.code) ||
            a.subject.localeCompare(b.subject) ||
            ((a.evidence?.path ?? '').localeCompare(b.evidence?.path ?? '')) ||
            ((a.evidence?.line ?? 0) - (b.evidence?.line ?? 0)));
    });
}
const STATE_ORDER = { finding: 0, error: 1, skipped: 2, pass: 3 };
export function sortChecks(checks) {
    return [...checks].sort((a, b) => {
        return (a.code.localeCompare(b.code) ||
            a.subject.localeCompare(b.subject) ||
            STATE_ORDER[a.state] - STATE_ORDER[b.state]);
    });
}
// ---------------------------------------------------------------------------
// 报告组装
// ---------------------------------------------------------------------------
export function buildReport(ctx, results, truncated) {
    let findings = [];
    let checks = [];
    let findingsTruncated = truncated || results.some((r) => r.truncated === true);
    for (const r of results) {
        findings = findings.concat(r.findings);
        checks = checks.concat(r.checks);
    }
    findings = sortFindings(findings);
    checks = sortChecks(checks);
    if (findings.length > LIMITS.findings) {
        findings = findings.slice(0, LIMITS.findings);
        findingsTruncated = true;
    }
    if (checks.length > LIMITS.checks) {
        checks = checks.slice(0, LIMITS.checks);
        findingsTruncated = true;
    }
    const riskVerdict = computeRiskVerdict(findings, ctx.strict);
    const coverageVerdict = computeCoverageVerdict(checks);
    const verdict = computeVerdict(riskVerdict, coverageVerdict);
    const summary = summarize(findings, checks);
    const rootLabel = redactPath(ctx.root, ctx.fixedRoot, ctx.home);
    const report = {
        tool: 'security_audit',
        version: 1,
        root: rootLabel,
        platform: ctx.platform,
        strict: ctx.strict,
        verdict,
        riskVerdict,
        coverageVerdict,
        summary,
        findings,
        checks,
        truncated: findingsTruncated,
    };
    const serialized = JSON.stringify(report);
    if (serialized.length > LIMITS.outputBytes) {
        throw new AuditTimeoutError(`security_audit: canonical output exceeds ${LIMITS.outputBytes} bytes`);
    }
    return report;
}
// ---------------------------------------------------------------------------
// 调度
// ---------------------------------------------------------------------------
async function runScanner(ctx, fn) {
    try {
        return await fn(ctx);
    }
    catch (error) {
        if (error instanceof AuditAbortedError || error instanceof AuditTimeoutError)
            throw error;
        const rule = RULE_BY_CODE.get('unknown-config-format');
        const msg = safeErrorMessage(error, ctx.root, ctx.home);
        return {
            checks: [{
                    code: 'internal-error',
                    state: 'error',
                    subject: `action:${ctx.action}`,
                    severity: 'info',
                    reason: `scanner failed: ${msg}`,
                }],
            findings: [{
                    severity: 'info',
                    code: 'internal-error',
                    category: ctx.action === 'scan_config' ? 'config' : ctx.action === 'scan_plugins' ? 'plugins' : ctx.action === 'scan_sessions' ? 'sessions' : 'network',
                    subject: `action:${ctx.action}`,
                    exposure: 'scanner raised an unexpected error; check skipped by design (not counted as pass)',
                    recommendation: 're-run the action; if it persists, report the sanitized message',
                    confidence: 'low',
                    ruleVersion: rule?.ruleVersion ?? 1,
                }],
        };
    }
}
export async function runAction(params, opts = {}) {
    if (!ACTIONS.includes(params.action)) {
        throw new AuditArgsError(`security_audit: unknown action ${String(params.action)}`);
    }
    if (params.action === 'rules') {
        return buildRulesOutput(opts.platform ?? process.platform);
    }
    throwIfAborted(opts.signal);
    const ctx = await buildContext(params, opts);
    const run = (fn) => runScanner(ctx, fn);
    let results;
    if (params.action === 'report') {
        // 顺序执行四个子扫描器，每个之间检查 deadline/signal
        const parts = [];
        for (const fn of [scanConfig, scanPlugins, scanSessions, scanNetwork]) {
            throwIfAborted(ctx.signal);
            throwIfDeadlineExceeded(ctx.deadline, ctx.signal);
            parts.push(await run(fn));
        }
        results = parts;
    }
    else {
        const fn = params.action === 'scan_config' ? scanConfig :
            params.action === 'scan_plugins' ? scanPlugins :
                params.action === 'scan_sessions' ? scanSessions : scanNetwork;
        results = [await run(fn)];
    }
    const truncated = false;
    return buildReport(ctx, results, truncated);
}
// 便捷导出（测试用）
export { isWithinPath };
