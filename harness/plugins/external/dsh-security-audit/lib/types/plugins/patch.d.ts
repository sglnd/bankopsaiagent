/**
 * cordis.patch.yml 行解析（设计 §7.2 数据来源）。
 * 目的解析器：处理 `- insert:` / `- remove:` / `- update:` 段下的
 * `- id:` / `- name:` / `- source:` 行，以及顶层直接列出的行。
 */
export type PatchSection = 'insert' | 'remove' | 'update';
export interface PatchRow {
    section: PatchSection;
    id?: string;
    name?: string;
    source?: string;
    /** 原始行号（1-based，报告定位用）。 */
    line: number;
}
export interface PatchParseResult {
    rows: PatchRow[];
    ok: boolean;
    reason?: string;
}
export declare function parsePatchRows(text: string): PatchParseResult;
