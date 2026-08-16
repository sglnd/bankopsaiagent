/**
 * POSIX 权限位纯函数（跨平台可测）。
 * credentials 建议 0600、目录建议 0700（设计 §8）。
 */
export function modeBits(mode) {
    const bit = (mask) => (mode & mask) !== 0;
    return {
        owner: { r: bit(0o400), w: bit(0o200), x: bit(0o100) },
        group: { r: bit(0o040), w: bit(0o020), x: bit(0o010) },
        other: { r: bit(0o004), w: bit(0o002), x: bit(0o001) },
    };
}
/** 凭据文件：推荐 0600。other 可读 → high；group 可读 → medium。 */
export function credentialModeIssues(mode) {
    const b = modeBits(mode);
    const issues = [];
    if (b.other.r)
        issues.push({ kind: 'other-read', severity: 'high', detail: 'credentials file readable by others' });
    if (b.group.r)
        issues.push({ kind: 'group-read', severity: 'medium', detail: 'credentials file readable by group' });
    if (b.other.w)
        issues.push({ kind: 'other-write', severity: 'high', detail: 'credentials file writable by others' });
    if (b.group.w)
        issues.push({ kind: 'group-write', severity: 'medium', detail: 'credentials file writable by group' });
    return issues;
}
/** 会话/配置目录：推荐 0700。other 任何位 → high/medium。 */
export function directoryModeIssues(mode) {
    const b = modeBits(mode);
    const issues = [];
    if (b.other.r || b.other.x)
        issues.push({ kind: 'other-read', severity: 'high', detail: 'directory traversable/readable by others' });
    if (b.group.r || b.group.x)
        issues.push({ kind: 'group-read', severity: 'medium', detail: 'directory traversable/readable by group' });
    return issues;
}
/** 会话文件（内容敏感）：推荐 0600。 */
export function sessionFileModeIssues(mode) {
    return credentialModeIssues(mode);
}
