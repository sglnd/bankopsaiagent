/**
 * DSH 本机安全审计插件（tool-bundle，只读诊断）。
 *
 * 注册 `security_audit` 工具：scan_config / scan_plugins / scan_sessions /
 * scan_network / report / rules 六个 action，输出脱敏、可复现、可定位的风险报告。
 *
 * 安全边界（设计文档 §2/§6/§8/§9）：
 * - 只读：绝不修改/删除被扫描文件，不执行插件，不连接远程；
 * - 秘密完整值永不出现在 canonical 输出（类型/长度/HMAC fingerprint/路径/行号）；
 * - 所有路径 lstat → realpath → containment；symlink/reparse escape 拒绝；
 * - root 固定为进程启动时解析的 $DSH_HOME，模型参数不能扩大读取范围
 *   （allowedRoots 只能来自插件配置）；
 * - 文件数/字节/并发/finding/输出全部有预算，timeoutMs 30s（cooperative）；
 * - capability finding 只提示人工确认用途，不裁定恶意。
 *
 * 接入方式：cordis.yml 追加
 *   - id: security-audit
 *     name: '@deepseek-ai/dsh-security-audit'
 */
import type { Context } from '@deepseek-ai/cordis';
export declare const name = "@deepseek-ai/dsh-security-audit";
export declare const inject: string[];
export interface SecurityAuditConfig {
    /** 仅测试/管理员声明：允许作为 root 扫描的额外绝对路径。模型参数不能扩大读取范围。 */
    allowedRoots?: unknown;
    /** 仅管理员声明：endpoint allowlist（规范化 scheme+host+port 精确匹配，无 wildcard）。 */
    allowedEndpoints?: unknown;
}
export declare function apply(ctx: Context, config?: SecurityAuditConfig): unknown;
