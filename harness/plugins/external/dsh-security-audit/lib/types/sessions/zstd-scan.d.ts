/**
 * zstd 帧边界扫描器 —— 零依赖（DataView 读字节），RFC 8878 帧结构。
 * stage-1 只解析 frame header + block header，不解码 block 数据（§7.3 解压炸弹边界）。
 * 与 dsh-session-health 的 frame scanner 保持行为一致（独立内部实现，不导入
 * monorepo 未公开路径——设计 §7.3 边界）。
 */
export interface FrameAnalysis {
    /** 是否以 zstd magic 开头。 */
    isZstd: boolean;
    /** frame header 是否完整可解析。 */
    headerComplete: boolean;
    /** 是否截断（torn）。 */
    torn: boolean;
    /** Frame_Content_Size（解析到时）。 */
    fcs?: number;
    /** 压缩文件尺寸。 */
    compressedSize: number;
    /** 完整帧数。 */
    frames: number;
    error?: 'not-zstd' | 'reserved-header' | 'reserved-block' | 'truncated';
}
export interface ParsedFrameHeader {
    descriptor: number;
    singleSegment: boolean;
    checksum: boolean;
    contentSizeFlag: number;
    fcs?: number;
    /** header 总字节数（magic + descriptor + window/dict/FCS）。 */
    headerSize: number;
}
/** 解析第一个 frame header；不足/非法时返回 null。 */
export declare function parseFrameHeader(buf: Uint8Array): ParsedFrameHeader | null;
/**
 * 分析一个 session 文件（最多读取前 maxBytes 字节，stage-1 只读头部）。
 */
export declare function analyzeZstd(buf: Uint8Array, compressedSize: number): FrameAnalysis;
export declare function isTempResidue(name: string): boolean;
