/**
 * 权限检查适配层（设计 §8 权限与平台策略）。
 * - Windows：无零副作用 ACL API → supported:false（调用方记 skipped，不记 pass）；
 * - POSIX：owner/group/other mode 检查，不自动 chmod。
 */
import { type ModeIssue } from './posix.ts';
export interface PermissionResult {
    supported: boolean;
    reason?: string;
    issues: ModeIssue[];
    /** 权限不足无法读取（lstat 失败）。 */
    unreadable?: string;
}
export declare function checkFilePermissions(p: string, opts?: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
}): Promise<PermissionResult>;
export declare function checkDirPermissions(p: string, opts?: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
}): Promise<PermissionResult>;
export declare function checkSessionFilePermissions(p: string, opts?: {
    platform?: NodeJS.Platform;
    signal?: AbortSignal;
}): Promise<PermissionResult>;
/** 供测试/纯逻辑使用的 mode 检查（无需真实文件）。 */
export declare function evaluateModeIssues(mode: number, kind: 'credential' | 'directory' | 'session-file'): ModeIssue[];
/** 仅测试辅助：以指定 mode 创建一个临时文件（不用于审计路径）。 */
export declare function statModeForTest(p: string): Promise<number | null>;
