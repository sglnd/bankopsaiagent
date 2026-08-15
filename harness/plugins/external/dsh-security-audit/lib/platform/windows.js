/**
 * Windows 权限策略（设计 §8）：
 * POSIX mode bits 在 Windows 不足以判断 ACL；无零副作用 ACL API 时
 * 权限规则返回 skipped（不是 pass）。系统命令读 ACL 推迟到 v2 并需 consent。
 */
export function windowsAclUnsupported(reason = 'Windows ACL 判定需要系统命令或非零副作用 API，v1 不执行进程；规则 skipped（不视为 pass）') {
    return { supported: false, reason };
}
