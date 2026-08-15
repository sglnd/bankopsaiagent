/**
 * 资源与时间预算（设计文档 §9 输出和资源限制）。
 * 所有预算都是 cooperative：遍历/读取/解码批次中显式检查。
 */
export const LIMITS = {
    /** 配置文件数上限。 */
    configFiles: 200,
    /** 单配置文件读取上限（防御性；配置通常远小于此）。 */
    configFileBytes: 1 * 1024 * 1024,
    /** 插件数上限。 */
    plugins: 200,
    /** 源码扫描文件数上限。 */
    sourceFiles: 5000,
    /** 单源码文件读取上限。 */
    sourceFileBytes: 1 * 1024 * 1024,
    /** 源码累计读取上限。 */
    sourceTotalBytes: 64 * 1024 * 1024,
    /** session 文件数上限。 */
    sessionFiles: 1000,
    /** 单 session 文件压缩数据读取上限（16 MiB）。 */
    sessionFileBytes: 16 * 1024 * 1024,
    /** 单帧 header 分析读取上限（stage-1 只读头部，无需整读）。 */
    sessionHeaderReadBytes: 64 * 1024,
    /** expansion ratio 告警阈值（100:1）。 */
    expansionRatioWarn: 100,
    /** ratio 告警必须同时满足的绝对输出量下限，避免小文件误报。 */
    expansionAbsoluteFloor: 1 * 1024 * 1024,
    /** 单帧 FCS 超预算阈值（对应 sessionFileBytes）。 */
    oversizedFrameBytes: 16 * 1024 * 1024,
    /** findings 上限。 */
    findings: 1000,
    /** checks 上限（防御；findings 已限 1000）。 */
    checks: 5000,
    /** canonical 输出上限。 */
    outputBytes: 2 * 1024 * 1024,
    /** 单 action timeout。 */
    actionTimeoutMs: 10_000,
    /** report timeout。 */
    reportTimeoutMs: 30_000,
    /** 目录遍历/文件读取并发上限。 */
    concurrency: 8,
};
