/**
 * scan_network 检查器（设计 §7.4）。
 * 不进行网络请求和端口探测；只读取配置（复用 config discover）
 * 与本机配置中的监听声明；无法判定时返回 contextual/info，不宣称安全。
 */
import { LIMITS } from '../limits.js';
import { readFileCapped, throwIfAborted, throwIfDeadlineExceeded } from '../paths.js';
import { displayUrl, redactPath } from '../redact.js';
import { RULE_BY_CODE } from '../rules.js';
import { discoverConfigFiles } from '../config/discover.js';
import { parseSafeByKind, scalarValues } from '../config/parse-safe.js';
import { classifyHostname, classifyUrl, isAllowedEndpoint } from './classify.js';
const LISTEN_KEY_RE = /(^|\.)(listen|bind|address|host)$/i;
const URL_KEY_RE = /url|endpoint|discovery|proxy|api[_-]?base|base[_-]?url/i;
const AUTH_KEY_RE = /auth|token|api[_-]?key|secret|password|credential/i;
const PROXY_KEY_RE = /proxy/i;
const CORS_KEY_RE = /cors|origin/i;
function pushFinding(_ctx, code, subject, t) {
    const rule = RULE_BY_CODE.get(code);
    return {
        severity: t.severity,
        code,
        category: 'network',
        subject,
        ...(t.evidence !== undefined ? { evidence: t.evidence } : {}),
        exposure: t.exposure,
        recommendation: t.recommendation,
        confidence: t.confidence,
        ruleVersion: rule?.ruleVersion ?? 1,
    };
}
async function scanFile(ctx, file, state) {
    const read = await readFileCapped(file.path, LIMITS.configFileBytes, ctx.signal);
    if (read.kind !== 'ok')
        return;
    const text = read.buf.toString('utf8');
    const parsed = parseSafeByKind(text, file.kind);
    const redactedPath = redactPath(file.path, ctx.root, ctx.home);
    const isCredentials = file.kind === 'credentials';
    if (isCredentials)
        state.hasCredentials = true;
    let fileHasAuth = false;
    let fileListen;
    const iterable = parsed.ok && parsed.data ? scalarValues(parsed.data) : [];
    for (const [k, v] of iterable) {
        if (typeof v !== 'string' || v === '')
            continue;
        const lowerKey = k.toLowerCase();
        // listen/bind/address/host
        if (LISTEN_KEY_RE.test(k) && !URL_KEY_RE.test(k)) {
            const cls = classifyHostname(v);
            if (cls === 'unspecified' || cls === 'loopback' || cls === 'private' || cls === 'external') {
                fileListen = { host: v, subject: `${file.rel}:${k}` };
            }
        }
        if (AUTH_KEY_RE.test(k)) {
            if (!/^(true|false|null)$/i.test(v) && !isCredentials)
                fileHasAuth = true;
        }
        if (CORS_KEY_RE.test(k)) {
            if (v === '*' || v === '**') {
                state.corsWildcard = true;
                state.corsSubject = `${file.rel}:${k}`;
            }
        }
        if (PROXY_KEY_RE.test(k) && /^https?:\/\//i.test(v)) {
            state.proxyConfigured = true;
            state.proxySubject = `${file.rel}:${k}`;
        }
        if (/^https?:\/\//i.test(v)) {
            const c = classifyUrl(v);
            if (c !== null) {
                if (URL_KEY_RE.test(k) && /discovery|model/i.test(lowerKey)) {
                    state.discoveryTargets.push({ subject: `${file.rel}:${k}`, value: v });
                }
                if (c.plaintext && c.addressClass !== 'loopback') {
                    state.httpTargets.push({ subject: `${file.rel}:${k}`, value: v });
                }
            }
        }
    }
    if (fileListen !== undefined) {
        state.listenHost = fileListen.host;
        state.listenSubject = fileListen.subject;
        state.listenAuth = fileHasAuth;
        state.listened = true;
    }
    // 行级兜底（解析失败时）：URL 提取
    if (!parsed.ok) {
        for (const m of text.matchAll(/https?:\/\/[^\s"')\]]+/g)) {
            const v = m[0];
            const c = classifyUrl(v);
            if (c === null)
                continue;
            const lower = v.toLowerCase();
            if (/discovery|model/i.test(lower)) {
                state.discoveryTargets.push({ subject: `${file.rel}:(line-scan)`, value: v });
            }
            if (c.plaintext && c.addressClass !== 'loopback') {
                state.httpTargets.push({ subject: `${file.rel}:(line-scan)`, value: v });
            }
        }
        void redactedPath;
    }
}
export async function scanNetwork(ctx) {
    const checks = [];
    const findings = [];
    const state = {
        listenAuth: false,
        hasCredentials: false,
        corsWildcard: false,
        proxyConfigured: false,
        discoveryTargets: [],
        httpTargets: [],
        listened: false,
    };
    const discovery = await discoverConfigFiles(ctx.root, { ...(ctx.profile !== undefined ? { profile: ctx.profile } : {}), signal: ctx.signal, deadline: ctx.deadline });
    for (const file of discovery.files) {
        throwIfAborted(ctx.signal);
        throwIfDeadlineExceeded(ctx.deadline, ctx.signal);
        await scanFile(ctx, file, state);
    }
    // 1) listen-all-interfaces / missing-auth-on-exposed-service
    if (state.listenHost !== undefined) {
        const cls = classifyHostname(state.listenHost);
        const subject = state.listenSubject ?? '(listen)';
        const evidence = { value: state.listenHost, redacted: false };
        if (cls === 'unspecified') {
            findings.push(pushFinding(ctx, 'listen-all-interfaces', subject, {
                severity: state.listenAuth ? 'medium' : 'high',
                exposure: state.listenAuth
                    ? 'service binds all interfaces (0.0.0.0/::); authentication is configured, still verify exposure'
                    : 'service binds all interfaces (0.0.0.0/::) without authentication evidence',
                recommendation: 'bind to loopback or configure authentication before exposing on all interfaces',
                confidence: 'high',
                evidence,
            }));
            checks.push({ code: 'listen-all-interfaces', state: 'finding', subject, severity: state.listenAuth ? 'medium' : 'high' });
        }
        else {
            checks.push({ code: 'listen-all-interfaces', state: 'pass', subject, severity: 'info' });
        }
        if (cls !== 'loopback' && !state.listenAuth) {
            findings.push(pushFinding(ctx, 'missing-auth-on-exposed-service', subject, {
                severity: 'high',
                exposure: 'non-loopback bind without authentication evidence',
                recommendation: 'require authentication or restrict the bind to loopback',
                confidence: 'medium',
                evidence,
            }));
            checks.push({ code: 'missing-auth-on-exposed-service', state: 'finding', subject, severity: 'high' });
        }
        else {
            checks.push({ code: 'missing-auth-on-exposed-service', state: 'pass', subject, severity: 'info' });
        }
    }
    else {
        checks.push({ code: 'listen-all-interfaces', state: 'skipped', subject: '(no listen config)', severity: 'info', skipReason: 'not-applicable', reason: 'no listen/bind configuration found' });
        checks.push({ code: 'missing-auth-on-exposed-service', state: 'skipped', subject: '(no listen config)', severity: 'info', skipReason: 'not-applicable', reason: 'no listen/bind configuration found' });
        checks.push({ code: 'unknown-listener-state', state: 'skipped', subject: '(listener state)', severity: 'info', skipReason: 'not-applicable', reason: 'actual bind state cannot be determined without active probing (v1 never probes)' });
    }
    // 2) plaintext-http-external
    const httpSeen = new Set();
    for (const t of state.httpTargets) {
        if (httpSeen.has(t.value))
            continue;
        httpSeen.add(t.value);
        findings.push(pushFinding(ctx, 'plaintext-http-external', t.subject, {
            severity: 'high',
            exposure: 'external target uses plaintext HTTP; credentials or data could be intercepted',
            recommendation: 'switch to HTTPS',
            confidence: 'high',
            evidence: { value: displayUrl(t.value), redacted: true },
        }));
    }
    if (state.httpTargets.length === 0) {
        checks.push({ code: 'plaintext-http-external', state: 'pass', subject: '(urls)', severity: 'info' });
    }
    // 3) external-model-discovery
    const discSeen = new Set();
    for (const t of state.discoveryTargets) {
        if (discSeen.has(t.value))
            continue;
        discSeen.add(t.value);
        const c = classifyUrl(t.value);
        if (c === null)
            continue;
        const allowed = isAllowedEndpoint(t.value, ctx.allowedEndpoints);
        if (c.addressClass === 'loopback' || allowed) {
            checks.push({ code: 'external-model-discovery', state: 'pass', subject: t.subject, severity: 'info' });
            continue;
        }
        findings.push(pushFinding(ctx, 'external-model-discovery', t.subject, {
            severity: 'high',
            exposure: 'model discovery points at a non-allowlisted target and may carry credentials; DNS resolution is not performed (v1)',
            recommendation: 'add the endpoint to the admin allowlist or use a loopback target',
            confidence: 'medium',
            evidence: { value: displayUrl(t.value), redacted: true },
        }));
    }
    if (state.discoveryTargets.length === 0) {
        checks.push({ code: 'external-model-discovery', state: 'skipped', subject: '(no discovery config)', severity: 'info', skipReason: 'not-applicable', reason: 'no model discovery configuration found' });
    }
    // 4) weak-cors
    if (state.corsWildcard) {
        findings.push(pushFinding(ctx, 'weak-cors', state.corsSubject ?? '(cors)', {
            severity: 'medium',
            exposure: 'CORS allows any origin while sensitive interfaces exist',
            recommendation: 'restrict allowed origins to trusted ones',
            confidence: 'high',
            evidence: { value: '*', redacted: false },
        }));
        checks.push({ code: 'weak-cors', state: 'finding', subject: state.corsSubject ?? '(cors)', severity: 'medium' });
    }
    else {
        checks.push({ code: 'weak-cors', state: 'pass', subject: '(cors)', severity: 'info' });
    }
    // 5) proxy-credential-route
    if (state.proxyConfigured && state.hasCredentials) {
        findings.push(pushFinding(ctx, 'proxy-credential-route', state.proxySubject ?? '(proxy)', {
            severity: 'medium',
            exposure: 'proxy is configured while credentials exist; credentialed requests may transit the proxy',
            recommendation: 'verify the proxy does not log or forward credentials; consider a no_proxy rule',
            confidence: 'medium',
            evidence: { value: displayUrl('https://proxy'), redacted: true },
        }));
        checks.push({ code: 'proxy-credential-route', state: 'finding', subject: state.proxySubject ?? '(proxy)', severity: 'medium' });
    }
    else {
        checks.push({ code: 'proxy-credential-route', state: 'skipped', subject: '(proxy)', severity: 'info', skipReason: 'not-applicable', reason: state.proxyConfigured ? 'no credentials found' : 'no proxy configuration found' });
    }
    return { checks, findings };
}
