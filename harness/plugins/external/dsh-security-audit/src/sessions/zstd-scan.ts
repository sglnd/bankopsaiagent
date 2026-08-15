/**
 * zstd 帧边界扫描器 —— 零依赖（DataView 读字节），RFC 8878 帧结构。
 * stage-1 只解析 frame header + block header，不解码 block 数据（§7.3 解压炸弹边界）。
 * 与 dsh-session-health 的 frame scanner 保持行为一致（独立内部实现，不导入
 * monorepo 未公开路径——设计 §7.3 边界）。
 */

export interface FrameAnalysis {
  /** 是否以 zstd magic 开头。 */
  isZstd: boolean
  /** frame header 是否完整可解析。 */
  headerComplete: boolean
  /** 是否截断（torn）。 */
  torn: boolean
  /** Frame_Content_Size（解析到时）。 */
  fcs?: number
  /** 压缩文件尺寸。 */
  compressedSize: number
  /** 完整帧数。 */
  frames: number
  error?: 'not-zstd' | 'reserved-header' | 'reserved-block' | 'truncated'
}

const ZSTD_MAGIC = 0xfd2fb528

function decodeFcs(dv: DataView, offset: number, sizeBytes: number): number {
  if (sizeBytes === 1) return dv.getUint8(offset)
  if (sizeBytes === 2) return 256 + dv.getUint16(offset, true)
  if (sizeBytes === 4) return 65536 + dv.getUint32(offset, true)
  const big = dv.getBigUint64(offset, true)
  return big > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(big)
}

export interface ParsedFrameHeader {
  descriptor: number
  singleSegment: boolean
  checksum: boolean
  contentSizeFlag: number
  fcs?: number
  /** header 总字节数（magic + descriptor + window/dict/FCS）。 */
  headerSize: number
}

/** 解析第一个 frame header；不足/非法时返回 null。 */
export function parseFrameHeader(buf: Uint8Array): ParsedFrameHeader | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (buf.byteLength < 5) return null
  if (dv.getUint32(0, true) !== ZSTD_MAGIC) return null
  const descriptor = dv.getUint8(4)
  if ((descriptor & 0x18) !== 0) return null // reserved bits
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 0x20) !== 0
  const checksum = (descriptor & 0x04) !== 0
  const dictionaryFlag = descriptor & 0x03
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0
    ? (singleSegment ? 1 : 0)
    : 1 << contentSizeFlag
  let p = 5
  if (!singleSegment) p += 1 // window descriptor
  p += dictionaryBytes
  if (p > buf.byteLength) return null
  let fcs: number | undefined
  if (contentSizeBytes > 0) {
    if (p + contentSizeBytes > buf.byteLength) return null
    fcs = decodeFcs(dv, p, contentSizeBytes)
    p += contentSizeBytes
  }
  return { descriptor, singleSegment, checksum, contentSizeFlag, ...(fcs !== undefined ? { fcs } : {}), headerSize: p }
}

/**
 * 分析一个 session 文件（最多读取前 maxBytes 字节，stage-1 只读头部）。
 */
export function analyzeZstd(buf: Uint8Array, compressedSize: number): FrameAnalysis {
  const base: FrameAnalysis = { isZstd: false, headerComplete: false, torn: false, compressedSize, frames: 0 }
  if (buf.byteLength < 4) {
    return { ...base, error: 'not-zstd' }
  }
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  if (dv.getUint32(0, true) !== ZSTD_MAGIC) {
    return { ...base, error: 'not-zstd' }
  }
  base.isZstd = true

  const header = parseFrameHeader(buf)
  if (header === null) {
    // magic 在但 header 不全 → torn
    const descriptor = dv.getUint8(4)
    if ((descriptor & 0x18) !== 0) {
      return { ...base, error: 'reserved-header' }
    }
    return { ...base, torn: true, error: 'truncated' }
  }
  base.headerComplete = true
  if (header.fcs !== undefined) base.fcs = header.fcs

  // block 遍历：block header 3 字节（last bit + type + size）
  let p = header.headerSize
  let blocks = 0
  for (;;) {
    if (buf.byteLength - p < 3) {
      // 头部完整但块数据不足 → torn
      return { ...base, torn: true, error: 'truncated' }
    }
    const blockHeader = dv.getUint8(p) | (dv.getUint8(p + 1) << 8) | (dv.getUint8(p + 2) << 16)
    p += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 0x03
    const blockSize = blockHeader >>> 3
    if (blockType === 0x03) {
      return { ...base, error: 'reserved-block' }
    }
    const payloadBytes = blockType !== 0x01 ? blockSize : 1
    if (buf.byteLength - p < payloadBytes) {
      return { ...base, torn: true, error: 'truncated' }
    }
    p += payloadBytes
    blocks++
    if (lastBlock) break
  }
  if (header.checksum) {
    if (buf.byteLength - p < 4) return { ...base, torn: true, error: 'truncated' }
    p += 4
  }
  base.frames = 1
  return base
}

export function isTempResidue(name: string): boolean {
  return /\.(tmp|part)(\.zstd)?$/.test(name) || name.endsWith('~') || /^~/.test(name)
}
