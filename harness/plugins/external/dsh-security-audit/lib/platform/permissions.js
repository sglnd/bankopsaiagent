/**
 * 权限检查适配层（设计 §8 权限与平台策略）。
 * - Windows：无零副作用 ACL API → supported:false（调用方记 skipped，不记 pass）；
 * - POSIX：owner/group/other mode 检查，不自动 chmod。
 */
import { promises as fs } from 'node:fs';
import { lstatSafe } from '../paths.js';
import { credentialModeIssues, directoryModeIssues, sessionFileModeIssues } from './posix.js';
import { windowsAclUnsupported } from './windows.js';
export async function checkFilePermissions(p, opts = {}) {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return { supported: false, reason: windowsAclUnsupported().reason, issues: [] };
    const stat = await lstatSafe(p);
    if (stat === null)
        return { supported: true, issues: [], unreadable: 'cannot stat file' };
    if (stat.isSymbolicLink())
        return { supported: true, issues: [], unreadable: 'symbolic link (not followed)' };
    return { supported: true, issues: credentialModeIssues(stat.mode) };
}
export async function checkDirPermissions(p, opts = {}) {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return { supported: false, reason: windowsAclUnsupported().reason, issues: [] };
    const stat = await lstatSafe(p);
    if (stat === null)
        return { supported: true, issues: [], unreadable: 'cannot stat directory' };
    return { supported: true, issues: directoryModeIssues(stat.mode) };
}
export async function checkSessionFilePermissions(p, opts = {}) {
    const platform = opts.platform ?? process.platform;
    if (platform === 'win32')
        return { supported: false, reason: windowsAclUnsupported().reason, issues: [] };
    const stat = await lstatSafe(p);
    if (stat === null)
        return { supported: true, issues: [], unreadable: 'cannot stat file' };
    return { supported: true, issues: sessionFileModeIssues(stat.mode) };
}
/** 供测试/纯逻辑使用的 mode 检查（无需真实文件）。 */
export function evaluateModeIssues(mode, kind) {
    switch (kind) {
        case 'credential':
            return credentialModeIssues(mode);
        case 'directory':
            return directoryModeIssues(mode);
        case 'session-file':
            return sessionFileModeIssues(mode);
    }
}
/** 仅测试辅助：以指定 mode 创建一个临时文件（不用于审计路径）。 */
export async function statModeForTest(p) {
    const st = await fs.lstat(p).catch(() => null);
    return st === null ? null : st.mode;
}
