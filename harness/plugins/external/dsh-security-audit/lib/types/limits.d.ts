/**
 * 资源与时间预算（设计文档 §9 输出和资源限制）。
 * 所有预算都是 cooperative：遍历/读取/解码批次中显式检查。
 */
export declare const LIMITS: {
    /** 配置文件数上限。 */
    readonly configFiles: 200;
    /** 单配置文件读取上限（防御性；配置通常远小于此）。 */
    readonly configFileBytes: number;
    /** 插件数上限。 */
    readonly plugins: 200;
    /** 源码扫描文件数上限。 */
    readonly sourceFiles: 5000;
    /** 单源码文件读取上限。 */
    readonly sourceFileBytes: number;
    /** 源码累计读取上限。 */
    readonly sourceTotalBytes: number;
    /** session 文件数上限。 */
    readonly sessionFiles: 1000;
    /** 单 session 文件压缩数据读取上限（16 MiB）。 */
    readonly sessionFileBytes: number;
    /** 单帧 header 分析读取上限（stage-1 只读头部，无需整读）。 */
    readonly sessionHeaderReadBytes: number;
    /** expansion ratio 告警阈值（100:1）。 */
    readonly expansionRatioWarn: 100;
    /** ratio 告警必须同时满足的绝对输出量下限，避免小文件误报。 */
    readonly expansionAbsoluteFloor: number;
    /** 单帧 FCS 超预算阈值（对应 sessionFileBytes）。 */
    readonly oversizedFrameBytes: number;
    /** findings 上限。 */
    readonly findings: 1000;
    /** checks 上限（防御；findings 已限 1000）。 */
    readonly checks: 5000;
    /** canonical 输出上限。 */
    readonly outputBytes: number;
    /** 单 action timeout。 */
    readonly actionTimeoutMs: 10000;
    /** report timeout。 */
    readonly reportTimeoutMs: 30000;
    /** 目录遍历/文件读取并发上限。 */
    readonly concurrency: 8;
};
