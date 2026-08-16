/**
 * scan_plugins 检查器（设计 §7.2）。
 * 数据来源：profile package.json 的 dsh.profile.bundles + cordis.patch.yml 行
 * + node_modules 已解析包 + 可选源码能力扫描（includeSourceScan）。
 * 与 plugin-check 的边界：本模块只做来源/权限/秘密/危险能力/加载边界，
 * 不复制结构合规规则，不通过模型工具间接获取结果。
 */
import type { AuditContext, ScannerResult } from '../types.ts';
import { type PackageLocation } from './package.ts';
export interface PluginDecl {
    id: string;
    name: string;
    source?: string;
    profile: string;
    origin: 'bundle' | 'patch';
    line?: number;
    location?: PackageLocation;
    resolved: boolean;
    escapeError?: string;
}
export declare function scanPlugins(ctx: AuditContext): Promise<ScannerResult>;
export { parsePatchRows, type PatchRow } from './patch.ts';
export type { SafePkg, PackageLocation } from './package.ts';
