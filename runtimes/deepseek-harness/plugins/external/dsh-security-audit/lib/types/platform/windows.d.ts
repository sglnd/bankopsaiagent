/**
 * Windows 权限策略（设计 §8）：
 * POSIX mode bits 在 Windows 不足以判断 ACL；无零副作用 ACL API 时
 * 权限规则返回 skipped（不是 pass）。系统命令读 ACL 推迟到 v2 并需 consent。
 */
export interface WindowsAclUnsupported {
    supported: false;
    reason: string;
}
export declare function windowsAclUnsupported(reason?: string): WindowsAclUnsupported;
