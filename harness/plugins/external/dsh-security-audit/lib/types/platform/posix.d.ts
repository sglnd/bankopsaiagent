/**
 * POSIX 权限位纯函数（跨平台可测）。
 * credentials 建议 0600、目录建议 0700（设计 §8）。
 */
export interface ModeBits {
    owner: {
        r: boolean;
        w: boolean;
        x: boolean;
    };
    group: {
        r: boolean;
        w: boolean;
        x: boolean;
    };
    other: {
        r: boolean;
        w: boolean;
        x: boolean;
    };
}
export declare function modeBits(mode: number): ModeBits;
export interface ModeIssue {
    kind: 'other-read' | 'group-read' | 'other-write' | 'group-write' | 'other-exec' | 'group-exec';
    severity: 'high' | 'medium';
    detail: string;
}
/** 凭据文件：推荐 0600。other 可读 → high；group 可读 → medium。 */
export declare function credentialModeIssues(mode: number): ModeIssue[];
/** 会话/配置目录：推荐 0700。other 任何位 → high/medium。 */
export declare function directoryModeIssues(mode: number): ModeIssue[];
/** 会话文件（内容敏感）：推荐 0600。 */
export declare function sessionFileModeIssues(mode: number): ModeIssue[];
