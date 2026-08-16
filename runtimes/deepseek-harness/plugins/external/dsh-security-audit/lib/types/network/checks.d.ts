/**
 * scan_network 检查器（设计 §7.4）。
 * 不进行网络请求和端口探测；只读取配置（复用 config discover）
 * 与本机配置中的监听声明；无法判定时返回 contextual/info，不宣称安全。
 */
import type { AuditContext, ScannerResult } from '../types.ts';
export declare function scanNetwork(ctx: AuditContext): Promise<ScannerResult>;
