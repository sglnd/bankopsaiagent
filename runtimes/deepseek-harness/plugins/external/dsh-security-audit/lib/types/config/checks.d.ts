/**
 * scan_config 检查器（设计 §7.1 规则）。
 * 只读：读取后不修改；行级秘密扫描 + 有限安全解析 + 权限适配。
 */
import type { AuditContext, Evidence, ScannerResult } from '../types.ts';
export interface FindingTemplate {
    severity?: import('../types.ts').Severity;
    exposure: string;
    recommendation: string;
    confidence: import('../types.ts').Confidence;
    evidence?: Evidence;
}
export declare function scanConfig(ctx: AuditContext): Promise<ScannerResult>;
