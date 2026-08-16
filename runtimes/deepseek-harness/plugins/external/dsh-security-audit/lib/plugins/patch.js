/**
 * cordis.patch.yml 行解析（设计 §7.2 数据来源）。
 * 目的解析器：处理 `- insert:` / `- remove:` / `- update:` 段下的
 * `- id:` / `- name:` / `- source:` 行，以及顶层直接列出的行。
 */
const SECTION_RE = /^-\s*(insert|remove|update):?\s*$/;
const ROW_ID_RE = /^-\s*id:\s*(.+)$/;
const KEY_RE = /^(id|name|source|path|version|link|root):\s*(.*)$/;
export function parsePatchRows(text) {
    const rows = [];
    let section = 'insert';
    let current = null;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
        const raw = lines[i];
        const line = raw.replace(/^\uFEFF/, '');
        if (!line.trim() || /^\s*#/.test(line))
            continue;
        const content = line.trim();
        const mSection = SECTION_RE.exec(content);
        if (mSection) {
            section = mSection[1];
            current = null;
            continue;
        }
        const mRow = ROW_ID_RE.exec(content);
        if (mRow) {
            current = { section, id: mRow[1].trim(), line: i + 1 };
            rows.push(current);
            continue;
        }
        const mKey = KEY_RE.exec(content);
        if (mKey && current !== null) {
            const key = mKey[1];
            const value = unquote(mKey[2].trim());
            if (key === 'id')
                current.id = value;
            else if (key === 'name')
                current.name = value;
            else if (key === 'source')
                current.source = value;
            continue;
        }
        // 无法识别结构 → 保守标记（不当作有效行）
        if (current !== null && content.startsWith('- ')) {
            // 嵌套子字段（如 patch 行下的其他 key）忽略
            continue;
        }
    }
    return { rows, ok: true };
}
function unquote(s) {
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"'))
        return s.slice(1, -1);
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'"))
        return s.slice(1, -1);
    return s;
}
