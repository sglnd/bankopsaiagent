/**
 * 插件包 package.json 安全读取与来源分类（设计 §7.2 数据来源）。
 * 只读；路径 containment。
 */
export interface SafePkg {
    name?: string;
    version?: string;
    main?: string;
    types?: string;
    files?: string[];
    exports?: Record<string, unknown> | string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    dsh?: {
        profile?: {
            bundles?: string[];
        };
        bundle?: {
            patch?: string;
        };
    };
    repository?: unknown;
}
export declare function readPackageSafe(dir: string, signal?: AbortSignal): Promise<SafePkg | null>;
export type PluginSourceKind = 'git' | 'npm' | 'file' | 'link' | 'workspace' | 'unknown';
export interface SourceMeta {
    kind: PluginSourceKind;
    /** git 来源是否固定 commit/tag/ref。 */
    pinned?: boolean;
}
/** 依据 patch row 的 source 字段分类来源。 */
export declare function classifySource(source: string | undefined): SourceMeta;
export interface PackageLocation {
    dir: string;
    pkg: SafePkg;
    sourceKind: PluginSourceKind;
}
/**
 * 解析插件包位置：
 * - node_modules/<name> 下（root 或 profile dir）；
 * - file:/link:/workspace: 相对路径（containment 校验，symlink 拒绝）。
 */
export declare function resolvePluginLocation(name: string, source: string | undefined, candidates: string[], signal?: AbortSignal): Promise<PackageLocation | null>;
/** install script 检查：preinstall/install/postinstall。 */
export declare function installScripts(pkg: SafePkg): string[];
