import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunkExtractedDocument, documentKind, extractDocument, isIndexableMediaType, splitText } from '../src/text.mjs'

test('recognizes supported text documents', () => {
  assert.equal(isIndexableMediaType('text/markdown', 'runbook.md'), true)
  assert.equal(isIndexableMediaType('application/octet-stream', 'service.log'), true)
  assert.equal(isIndexableMediaType('application/pdf', 'manual.pdf'), true)
  assert.equal(documentKind('application/pdf', 'manual.bin'), 'pdf')
  assert.equal(documentKind('application/octet-stream', 'manual.docx'), 'docx')
})

test('extracts and chunks text with bounded overlap', async () => {
  const extracted = await extractDocument(Buffer.from('A'.repeat(700) + '\n\n' + 'B'.repeat(700)), 'text/plain', 'test.txt')
  const text = extracted.pages[0].text
  const chunks = splitText(text, { maxChars:800, overlapChars:100 })
  assert.ok(chunks.length >= 2)
  assert.ok(chunks.every(chunk => chunk.length <= 800))
  assert.match(chunks.at(-1), /B+$/)
  assert.ok(chunkExtractedDocument(extracted).length >= 1)
})
