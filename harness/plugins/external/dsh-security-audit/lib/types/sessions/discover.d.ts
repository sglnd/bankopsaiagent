/**
 * session 文件发现（设计 §7.3）：扫描 $DSH_HOME/sessions 两级布局。
 * 与 dsh-session-health 布局一致：<root>/<cwd 编码>/<session-id>/session.jsonl.zstd
 * 加 stray 文件（*.tmp / *.tmp.zstd）。只读；lstat 拒绝 symlink。
 */
export interface SessionEntry {
    path: string;
    /** 相对 sessions root 的路径（正斜杠）。 */
    rel: string;
    name: string;
    kind: 'session' | 'stray' | 'symlink' | 'other';
    bytes: number;
    isDirectory: boolean;
}
export interface SessionsDiscovery {
    entries: SessionEntry[];
    truncated: boolean;
    warnings: string[];
    rootExists: boolean;
}
export declare function sessionsRootOf(dshHome: string): string;
export declare function discoverSessions(root: string, opts?: {
    signal?: AbortSignal;
    deadline: number;
    maxFiles?: number;
}): Promise<SessionsDiscovery>;
