/**
 * scan_sessions 检查器（设计 §7.3 规则；只做安全相关有限规则，
 * 完整健康诊断交给 session_health，可在 recommendation 中建议调用）。
 */
import type { AuditContext, ScannerResult } from '../types.ts';
export declare function scanSessions(ctx: AuditContext): Promise<ScannerResult>;
export { isTempResidue } from './zstd-scan.ts';
