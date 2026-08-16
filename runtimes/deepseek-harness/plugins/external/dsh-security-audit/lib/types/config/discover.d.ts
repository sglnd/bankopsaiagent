/**
 * 配置文件发现（设计 §7.1 目标文件）：按存在性发现，不硬编码只有一种布局。
 * 只读；lstat 拒绝 symlink；显式计数预算。
 */
export type ConfigFileKind = 'env' | 'settings' | 'credentials' | 'config' | 'package' | 'patch' | 'other';
export interface ConfigFile {
    path: string;
    /** 相对 root 的路径（正斜杠）。 */
    rel: string;
    kind: ConfigFileKind;
    bytes: number;
}
export interface ConfigDiscovery {
    files: ConfigFile[];
    truncated: boolean;
    warnings: string[];
}
/** 发现 root 与 root/profiles/* 下的配置文件；预算 LIMITS.configFiles。 */
export declare function discoverConfigFiles(root: string, opts?: {
    profile?: string;
    signal?: AbortSignal;
    deadline: number;
    maxFiles?: number;
}): Promise<ConfigDiscovery>;
