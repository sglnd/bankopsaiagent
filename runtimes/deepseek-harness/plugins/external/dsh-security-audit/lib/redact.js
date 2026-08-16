/**
 * 脱敏模块（设计文档 §6 脱敏设计）。
 *
 * - 秘密完整值永不出现在 canonical 输出 / 错误消息 / 日志；
 * - fingerprint 使用进程内随机 HMAC key，单次报告内稳定，跨报告不可追踪；
 * - 路径：$DSH_HOME 根 → `$DSH_HOME`，用户主目录 → `~`；
 * - URL 展示值剥离 userinfo（秘密）并截断路径。
 */
import { createHmac, randomBytes } from 'node:crypto';
export const REDACTED = '<redacted>';
/**
 * 测试 token allowlist（安全 fixture 原则 §11.1）：明显无效的测试值
 * 不产生误报。生产环境管理员可通过插件配置扩展 allowlist。
 */
export const TEST_TOKEN_ALLOWLIST = [
    /^dsh_test_not_a_real_secret_/,
];
const SECRET_PATTERNS = [
    { kind: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
    { kind: 'api-key', re: /\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/ },
    { kind: 'api-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
    { kind: 'api-key', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
    { kind: 'api-key', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
    { kind: 'api-key', re: /\bdsh_[A-Za-z0-9]{16,}\b/ },
    {
        kind: 'generic-secret',
        re: /\b(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|private[_-]?key|client[_-]?secret)\b["']?\s*[:=]\s*["']?([A-Za-z0-9+/_.=-]{12,})/i,
        group: 1,
    },
];
function isAllowlisted(value, allowlist) {
    return allowlist.some((re) => re.test(value));
}
function lineOf(text, index) {
    let line = 1;
    for (let i = 0; i < index && i < text.length; i++) {
        if (text.charCodeAt(i) === 10)
            line++;
    }
    return line;
}
/** 在文本中查找疑似秘密；allowlisted 测试值跳过。返回去重后的命中（按出现顺序）。 */
export function scanSecrets(text, allowlist = TEST_TOKEN_ALLOWLIST) {
    const hits = [];
    const seen = new Set();
    for (const { kind, re, group } of SECRET_PATTERNS) {
        const regex = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
        for (const m of text.matchAll(regex)) {
            const value = group === 1 ? (m[1] ?? m[0]) : m[0];
            if (isAllowlisted(value, allowlist))
                continue;
            if (seen.has(value))
                continue;
            seen.add(value);
            hits.push({ kind, value, index: m.index ?? 0, line: lineOf(text, m.index ?? 0) });
        }
    }
    hits.sort((a, b) => a.index - b.index);
    return hits;
}
/**
 * 单次报告内 redactor：随机 HMAC key 在构造时生成，报告结束即丢弃。
 * fingerprint 仅在单次报告内可关联同一秘密，不可跨报告追踪（§6.2）。
 */
export class Redactor {
    #key = randomBytes(32);
    fingerprint(value) {
        return createHmac('sha256', this.#key).update(value, 'utf8').digest('hex').slice(0, 16);
    }
    /** 秘密证据：只含类型/长度/fingerprint/行号，绝不包含完整值。 */
    secretEvidence(hit, path) {
        return {
            ...(path !== undefined ? { path } : {}),
            line: hit.line,
            secretKind: hit.kind,
            secretLength: hit.value.length,
            fingerprint: this.fingerprint(hit.value),
            redacted: true,
        };
    }
    /** 通用秘密证据（无行号场景）。 */
    secretEvidenceValue(value, path) {
        return {
            ...(path !== undefined ? { path } : {}),
            secretKind: classifySecret(value)?.kind ?? 'generic-secret',
            secretLength: value.length,
            fingerprint: this.fingerprint(value),
            redacted: true,
        };
    }
}
export function classifySecret(value) {
    for (const { kind, re } of SECRET_PATTERNS) {
        if (re.test(value))
            return { kind, length: value.length };
    }
    return null;
}
/**
 * 路径脱敏（§6.3）：优先 $DSH_HOME 根，其次用户主目录。
 * 字符串级 containment（不 realpath）；比较大小写不敏感（win32），
 * 输出保留原始大小写。
 */
export function redactPath(p, root, home, win = process.platform === 'win32') {
    const normalize = (s) => s.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '');
    const orig = normalize(p);
    const cmp = (s) => (win ? normalize(s).toLowerCase() : normalize(s));
    const r = cmp(root);
    const h = cmp(home);
    const t = cmp(orig);
    if (r !== '' && (t === r || t.startsWith(r + '/'))) {
        return t === r ? '$DSH_HOME' : '$DSH_HOME' + orig.slice(normalize(root).length);
    }
    if (h !== '' && (t === h || t.startsWith(h + '/'))) {
        return t === h ? '~' : '~' + orig.slice(normalize(home).length);
    }
    // 兜底：只返回 basename，避免泄漏其他用户目录
    return p.split(/[\\/]/).pop() ?? p;
}
/** 在任意文本中替换 root/home 绝对路径为脱敏形式（用于错误消息/展示）。 */
export function redactPathInText(text, root, home) {
    let out = text;
    const replace = (abs, token) => {
        if (abs === '')
            return;
        const variants = [abs, abs.replace(/\\/g, '/')];
        for (const v of variants) {
            out = out.split(v).join(token);
        }
    };
    replace(root, '$DSH_HOME');
    replace(home, '~');
    return out;
}
/**
 * URL 展示值：剥离 userinfo（秘密）并截断路径，host 保留（endpoint 定位所需）。
 */
export function displayUrl(raw) {
    try {
        const u = new URL(raw);
        const host = u.hostname;
        const port = u.port ? `:${u.port}` : '';
        const userinfo = u.username !== '' || u.password !== '' ? '***@' : '';
        let path = u.pathname;
        if (path.length > 24)
            path = path.slice(0, 12) + '…' + path.slice(-8);
        const query = u.search !== '' ? '?…' : '';
        return `${u.protocol}//${userinfo}${host}${port}${path}${query}`;
    }
    catch {
        return raw.length > 40 ? raw.slice(0, 16) + '…' + raw.slice(-8) : raw;
    }
}
/** 错误消息安全化：路径脱敏 + 截断，绝不嵌入文件内容。 */
export function safeErrorMessage(error, root, home) {
    const msg = error instanceof Error ? error.message : String(error);
    const redacted = redactPathInText(msg, root, home);
    return redacted.length > 500 ? redacted.slice(0, 500) + '…' : redacted;
}
