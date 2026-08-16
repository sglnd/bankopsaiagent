/**
 * 地址/URL 分类（设计 §7.4）：
 * - loopback：localhost、127.0.0.0/8、::1；
 * - unspecified bind：0.0.0.0、::；
 * - private/link-local 不是安全等价于 loopback（至少 medium/contextual）；
 * - v1 不主动解析 hostname（需要网络/DNS），仅按字面和 URL 结构分类；
 * - userinfo 视为秘密泄漏风险；
 * - allowlist 按规范化的 scheme+hostname+effective port 精确匹配，
 *   默认不允许 wildcard、路径前缀或 userinfo。
 */
export type AddressClass = 'loopback' | 'unspecified' | 'private' | 'external' | 'unknown';
export interface UrlClass {
    url: URL;
    protocol: string;
    hostname: string;
    port: number;
    addressClass: AddressClass;
    hasUserinfo: boolean;
    plaintext: boolean;
}
export declare function classifyHostname(host: string): AddressClass;
export declare function classifyUrl(raw: string): UrlClass | null;
/** 规范化 endpoint：scheme://hostname:effectivePort（小写，无路径/query/userinfo）。 */
export declare function normalizeEndpoint(raw: string): string | null;
/**
 * allowlist 精确匹配（设计 §7.4）：条目按规范化的 scheme+hostname+port 匹配，
 * 无 wildcard/路径前缀/userinfo；含 wildcard、路径、query、userinfo 的条目
 * 视为无效配置，永不匹配任何 URL。allowlist 仅降低"未知外部目标"规则。
 */
export declare function isAllowedEndpoint(raw: string, allowlist: readonly string[]): boolean;
/** 是否 loopback（含 unspecified 之外的安全判断）。 */
export declare function isLoopback(c: UrlClass): boolean;
