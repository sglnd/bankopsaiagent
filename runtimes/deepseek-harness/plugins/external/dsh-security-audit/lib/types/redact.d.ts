/**
 * 脱敏模块（设计文档 §6 脱敏设计）。
 *
 * - 秘密完整值永不出现在 canonical 输出 / 错误消息 / 日志；
 * - fingerprint 使用进程内随机 HMAC key，单次报告内稳定，跨报告不可追踪；
 * - 路径：$DSH_HOME 根 → `$DSH_HOME`，用户主目录 → `~`；
 * - URL 展示值剥离 userinfo（秘密）并截断路径。
 */
import type { Evidence } from './types.ts';
export declare const REDACTED = "<redacted>";
export type SecretKind = 'private-key' | 'api-key' | 'generic-secret';
export interface SecretHit {
    kind: SecretKind;
    value: string;
    index: number;
    line: number;
}
/**
 * 测试 token allowlist（安全 fixture 原则 §11.1）：明显无效的测试值
 * 不产生误报。生产环境管理员可通过插件配置扩展 allowlist。
 */
export declare const TEST_TOKEN_ALLOWLIST: readonly RegExp[];
/** 在文本中查找疑似秘密；allowlisted 测试值跳过。返回去重后的命中（按出现顺序）。 */
export declare function scanSecrets(text: string, allowlist?: readonly RegExp[]): SecretHit[];
/**
 * 单次报告内 redactor：随机 HMAC key 在构造时生成，报告结束即丢弃。
 * fingerprint 仅在单次报告内可关联同一秘密，不可跨报告追踪（§6.2）。
 */
export declare class Redactor {
    #private;
    fingerprint(value: string): string;
    /** 秘密证据：只含类型/长度/fingerprint/行号，绝不包含完整值。 */
    secretEvidence(hit: SecretHit, path?: string): Evidence;
    /** 通用秘密证据（无行号场景）。 */
    secretEvidenceValue(value: string, path?: string): Evidence;
}
export declare function classifySecret(value: string): {
    kind: SecretKind;
    length: number;
} | null;
/**
 * 路径脱敏（§6.3）：优先 $DSH_HOME 根，其次用户主目录。
 * 字符串级 containment（不 realpath）；比较大小写不敏感（win32），
 * 输出保留原始大小写。
 */
export declare function redactPath(p: string, root: string, home: string, win?: boolean): string;
/** 在任意文本中替换 root/home 绝对路径为脱敏形式（用于错误消息/展示）。 */
export declare function redactPathInText(text: string, root: string, home: string): string;
/**
 * URL 展示值：剥离 userinfo（秘密）并截断路径，host 保留（endpoint 定位所需）。
 */
export declare function displayUrl(raw: string): string;
/** 错误消息安全化：路径脱敏 + 截断，绝不嵌入文件内容。 */
export declare function safeErrorMessage(error: unknown, root: string, home: string): string;
