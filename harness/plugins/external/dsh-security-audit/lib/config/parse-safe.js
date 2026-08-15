/**
 * 安全解析（设计 §7.1 配置解析策略）：
 * - JSON：JSON.parse；
 * - YAML：有限、只读的子集解析（嵌套 map + `- item` 列表），扁平化为
 *   dotted-key map；`!!`/`&`/`*`/`|`/`>` 等结构拒绝，降级行级扫描；
 * - 不执行任何构造器，不解析 shell 命令替换；
 * - 无法可信解析 → ok:false（调用方降级行级模式扫描并标记 confidence）。
 */
export function parseJsonSafe(text) {
    try {
        const value = JSON.parse(text);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            return { ok: true, data: flattenObject(value, '') };
        }
        return { ok: true, data: {} };
    }
    catch {
        return { ok: false, reason: 'invalid-json' };
    }
}
/** .env（KEY=VALUE）解析：只读，不执行 shell 展开。 */
export function parseEnvSafe(text) {
    const data = {};
    for (const raw of text.split(/\r?\n/)) {
        const line = raw.replace(/^\uFEFF/, '').trim();
        if (line === '' || line.startsWith('#'))
            continue;
        const eq = line.indexOf('=');
        if (eq <= 0)
            return { ok: false, reason: 'unsupported-env-line' };
        const key = line.slice(0, eq).trim();
        if (!KEY_RE.test(key))
            return { ok: false, reason: `unsupported-key:${key}` };
        data[key] = unquote(line.slice(eq + 1).trim());
    }
    return { ok: true, data };
}
function flattenObject(obj, prefix, out = {}) {
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix === '' ? k : `${prefix}.${k}`;
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            flattenObject(v, key, out);
        }
        else {
            out[key] = v;
        }
    }
    return out;
}
function stripComment(line) {
    // 行首 # 或空格后的 # 视为注释（避免 URL fragment 误伤）
    const m = /(^|\s+)#/.exec(line);
    if (!m)
        return line;
    return m.index === 0 ? '' : line.slice(0, m.index);
}
function unquote(s) {
    const t = s.trim();
    if (t.length >= 2 && t.startsWith('"') && t.endsWith('"'))
        return t.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    if (t.length >= 2 && t.startsWith("'") && t.endsWith("'"))
        return t.slice(1, -1);
    return t;
}
function parseScalar(s) {
    const t = unquote(s);
    if (t === 'null' || t === '~')
        return null;
    if (t === 'true')
        return true;
    if (t === 'false')
        return false;
    if (/^-?\d+$/.test(t))
        return Number(t);
    if (/^-?\d+\.\d+$/.test(t))
        return Number(t);
    return t;
}
const KEY_RE = /^[A-Za-z0-9_.-]+$/;
/**
 * 有限 YAML 子集解析：嵌套 map（缩进）+ `- item` 列表。
 * 输出扁平 dotted-key map（如 `server.host`、`cors.origins` 数组）。
 * 遇到不安全/不支持结构返回 ok:false。
 */
export function parseYamlSafe(text) {
    if (/!!|\s&[A-Za-z]|\s\*[A-Za-z]/.test(text)) {
        return { ok: false, reason: 'unsafe-yaml-construct' };
    }
    const lines = [];
    for (const raw of text.split(/\r?\n/)) {
        const line = stripComment(raw.replace(/^\uFEFF/, ''));
        if (!line.trim())
            continue;
        lines.push({ indent: line.length - line.trimStart().length, text: line.trim() });
    }
    if (lines.length === 0)
        return { ok: true, data: {} };
    const out = {};
    /** key 栈：每层记录 { key, indent }，用真实缩进判定层级。 */
    const stack = [];
    let listPath = null;
    let listIndent = -1;
    const parentPath = () => stack.map((s) => s.key).join('.');
    for (const { indent, text } of lines) {
        if (text.startsWith('- ')) {
            const rest = text.slice(2).trim();
            if (listPath === null || indent <= listIndent) {
                if (stack.length === 0)
                    return { ok: false, reason: 'top-level-list-unsupported' };
                const parentKey = parentPath();
                const existing = out[parentKey];
                if (existing !== undefined && !Array.isArray(existing)) {
                    // 容器占位（{}）→ 转为列表；非占位冲突则拒绝
                    if (typeof existing === 'object' && existing !== null && Object.keys(existing).length === 0) {
                        out[parentKey] = [];
                    }
                    else {
                        return { ok: false, reason: 'conflicting-values' };
                    }
                }
                if (!Array.isArray(out[parentKey]))
                    out[parentKey] = [];
                listPath = parentKey;
                listIndent = indent;
            }
            const arr = out[listPath];
            const colon = rest.indexOf(':');
            if (colon > 0 && KEY_RE.test(rest.slice(0, colon).trim()) && rest.slice(colon + 1).trim() === '') {
                // list-of-map 项（如 patch 的 - id: x）；settings 中少见，保守拒绝
                return { ok: false, reason: 'list-of-map-unsupported' };
            }
            arr.push(parseScalar(rest));
            continue;
        }
        listPath = null;
        // 缩进不深于栈顶 → 弹出，直到栈顶缩进严格小于当前行
        while (stack.length > 0 && indent <= stack[stack.length - 1].indent) {
            stack.pop();
        }
        const colon = text.indexOf(':');
        if (colon <= 0)
            return { ok: false, reason: 'unsupported-line' };
        const key = unquote(text.slice(0, colon).trim());
        if (!KEY_RE.test(key))
            return { ok: false, reason: `unsupported-key:${key}` };
        const p = parentPath();
        const fullPath = p === '' ? key : `${p}.${key}`;
        const rest = text.slice(colon + 1).trim();
        if (rest === '') {
            // 嵌套容器：下一层更深的 key 会挂到它下面；先占位避免列表误判
            out[fullPath] = {};
            stack.push({ key, indent });
        }
        else {
            out[fullPath] = parseScalar(rest);
        }
    }
    // 清理嵌套容器占位（其子键已扁平挂出）
    const final = {};
    for (const [k, v] of Object.entries(out)) {
        if (v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0 && k !== '') {
            continue;
        }
        final[k] = v;
    }
    return { ok: true, data: final };
}
export function parseSafeByKind(text, kind) {
    if (kind === 'env')
        return parseEnvSafe(text);
    if (text.trimStart().startsWith('{'))
        return parseJsonSafe(text);
    return parseYamlSafe(text);
}
/** 从扁平数据中按 dotted key 取路径值。 */
export function getPath(data, dotted) {
    return data[dotted];
}
/** 遍历扁平数据所有标量值。 */
export function* scalarValues(data) {
    for (const [k, v] of Object.entries(data)) {
        if (Array.isArray(v)) {
            for (let i = 0; i < v.length; i++)
                yield [`${k}[${i}]`, v[i]];
        }
        else if (v !== null && typeof v === 'object') {
            continue;
        }
        else {
            yield [k, v];
        }
    }
}
