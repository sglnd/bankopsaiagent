/**
 * 可选源码能力扫描（设计 §7.2 source-capabilities）。
 * includeSourceScan=true 时启用；只提示能力存在，绝不裁定恶意（§7.2 重要）。
 */
import type { AuditContext, Finding } from '../types.ts';
interface CapPattern {
    code: 'dynamic-code-execution' | 'process-execution-capability' | 'network-capability';
    re: RegExp;
}
export interface SourceScanState {
    files: number;
    bytes: number;
    truncated: boolean;
}
export interface CapabilityHit {
    code: CapPattern['code'];
    file: string;
    line: number;
    match: string;
}
export declare function scanSourceCapabilities(pkgDir: string, opts: {
    signal?: AbortSignal;
    deadline: number;
    state: SourceScanState;
}): Promise<{
    hits: CapabilityHit[];
    warnings: string[];
}>;
/**
 * 将能力命中转为 finding：能力 ≠ 恶意（设计 §7.2 重要），
 * exposure 明确要求人工确认用途，confidence 保持 medium/high 但措辞中性。
 */
export declare function capabilityFindings(ctx: AuditContext, pkgName: string, hits: CapabilityHit[]): Finding[];
/** secret-like-file：插件包中携带 .env / *.pem / *.key / id_rsa 等。 */
export declare function findSecretLikeFiles(pkgDir: string, opts: {
    signal?: AbortSignal;
    deadline: number;
}): Promise<string[]>;
export {};
