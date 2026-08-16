import { config } from './config.mjs'

const TEXT_MEDIA_TYPES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/tab-separated-values', 'text/yaml',
  'application/json', 'application/yaml', 'application/x-yaml', 'application/xml', 'text/xml',
])

function baseMediaType(mediaType = '') {
  return mediaType.split(';')[0].trim().toLowerCase()
}

export function documentKind(mediaType = '', filename = '') {
  const media = baseMediaType(mediaType)
  if (media === 'application/pdf' || /\.pdf$/i.test(filename)) return 'pdf'
  if (media === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || /\.docx$/i.test(filename)) return 'docx'
  if (TEXT_MEDIA_TYPES.has(media) || /\.(txt|md|markdown|csv|tsv|json|ya?ml|xml|log|conf|ini|properties)$/i.test(filename)) return 'text'
  return 'unsupported'
}

export function isIndexableMediaType(mediaType = '', filename = '') {
  return documentKind(mediaType, filename) !== 'unsupported'
}

function normalizeText(value) {
  return value.replace(/\u0000/g, '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}

function enforceExtractionLimits(pages) {
  if (pages.length > config.maxDocumentPages) throw new TypeError(`document exceeds ${config.maxDocumentPages} page limit`)
  const charCount = pages.reduce((sum, page) => sum + page.text.length, 0)
  if (charCount > config.maxExtractedChars) throw new TypeError(`document exceeds ${config.maxExtractedChars} extracted character limit`)
  if (charCount === 0) throw new TypeError('document contains no extractable text; scanned documents require OCR')
  return { pages, charCount }
}

async function extractPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({ data:new Uint8Array(buffer), isEvalSupported:false, useWorkerFetch:false })
  const document = await loadingTask.promise
  try {
    if (document.numPages > config.maxDocumentPages) throw new TypeError(`document exceeds ${config.maxDocumentPages} page limit`)
    const pages = []
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent({ includeMarkedContent:false, disableNormalization:false })
      const parts = []
      for (const item of content.items) {
        if (!('str' in item)) continue
        parts.push(item.str)
        if (item.hasEOL) parts.push('\n')
      }
      pages.push({ pageNumber, text:normalizeText(parts.join(' ')) })
      page.cleanup()
    }
    return enforceExtractionLimits(pages)
  } finally {
    if (typeof document.cleanup === 'function') await document.cleanup()
    if (typeof loadingTask.destroy === 'function') await loadingTask.destroy()
  }
}

async function extractDocx(buffer) {
  const mammoth = (await import('mammoth')).default
  const result = await mammoth.extractRawText({ buffer }, { externalFileAccess:false })
  const extracted = enforceExtractionLimits([{ pageNumber:null, text:normalizeText(result.value) }])
  return { ...extracted, warnings:result.messages.map(message => String(message.message ?? message)).slice(0, 20) }
}

export async function extractDocument(buffer, mediaType, filename) {
  const kind = documentKind(mediaType, filename)
  if (kind === 'pdf') return { kind, ...(await extractPdf(buffer)), warnings:[] }
  if (kind === 'docx') return { kind, ...(await extractDocx(buffer)) }
  if (kind === 'text') return { kind, ...enforceExtractionLimits([{ pageNumber:null, text:normalizeText(buffer.toString('utf8')) }]), warnings:[] }
  throw new TypeError(`unsupported media type for indexing: ${mediaType || 'unknown'}`)
}

export function splitText(text, { maxChars = 1200, overlapChars = 180 } = {}) {
  if (maxChars < 200 || overlapChars < 0 || overlapChars >= maxChars) throw new TypeError('invalid chunk settings')
  const normalized = normalizeText(text)
  const chunks = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + maxChars, normalized.length)
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n\n', end), normalized.lastIndexOf('。', end), normalized.lastIndexOf('. ', end))
      if (boundary > start + Math.floor(maxChars * 0.55)) end = boundary + 1
    }
    const content = normalized.slice(start, end).trim()
    if (content) chunks.push(content)
    if (end >= normalized.length) break
    start = Math.max(start + 1, end - overlapChars)
  }
  return chunks
}

export function chunkExtractedDocument(extracted, options) {
  const chunks = []
  for (const page of extracted.pages) {
    for (const content of splitText(page.text, options)) chunks.push({ content, pageNumber:page.pageNumber })
  }
  return chunks
}
