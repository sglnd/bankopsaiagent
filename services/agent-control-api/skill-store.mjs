import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, posix } from 'node:path'

const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const REFERENCE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*\.md$/
const RESERVED_NAMES = new Set(['change-impact-analysis', 'inspect-application-system'])
const MAX_SKILL_BYTES = 256 * 1024

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode })
}

function safeName(value) {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!NAME_PATTERN.test(name) || name.length > 64) throw httpError('skill name must be lowercase hyphen-case and at most 64 characters', 400)
  if (RESERVED_NAMES.has(name)) throw httpError('skill name is reserved by a built-in BankOps skill', 409)
  return name
}

function normalizeReferenceName(value) {
  if (typeof value !== 'string' || !REFERENCE_PATTERN.test(value) || value.includes('..') || value.startsWith('/')) {
    throw httpError(`invalid reference path: ${value}`, 400)
  }
  return posix.normalize(value)
}

export function parseSkillFrontmatter(skillMd) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(skillMd)
  if (!match) throw new Error('SKILL.md must start with YAML frontmatter')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
    if (!item) throw new Error(`unsupported frontmatter line: ${line}`)
    metadata[item[1]] = item[2].replace(/^['"]|['"]$/g, '').trim()
  }
  return { metadata, body: match[2] }
}

function normalizeInput(input, expectedName) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw httpError('request body must be a JSON object', 400)
  const name = safeName(expectedName ?? input.name)
  let skillMd = typeof input.skillMd === 'string' ? input.skillMd : undefined
  if (!skillMd && typeof input.description === 'string' && typeof input.content === 'string') {
    skillMd = `---\nname: ${name}\ndescription: ${input.description.trim()}\n---\n\n${input.content.trim()}\n`
  }
  if (!skillMd || Buffer.byteLength(skillMd) > MAX_SKILL_BYTES) throw httpError('skillMd is required and must be at most 256 KiB', 400)

  const references = {}
  for (const [path, content] of Object.entries(input.references ?? {})) {
    const normalized = normalizeReferenceName(path)
    if (typeof content !== 'string') throw httpError(`reference ${path} must be a string`, 400)
    references[normalized] = content
  }
  const selectedTools = (input.selectedTools ?? []).map(item => {
    if (!item || typeof item.server !== 'string' || typeof item.tool !== 'string') {
      throw httpError('selectedTools entries require server and tool', 400)
    }
    return { server: item.server.trim(), tool: item.tool.trim() }
  })
  if (selectedTools.length > 100) throw httpError('selectedTools supports at most 100 entries', 400)
  const uniqueTools = [...new Map(selectedTools.map(item => [`${item.server}:${item.tool}`, item])).values()]
  const interfaceMetadata = {
    displayName: String(input.interface?.displayName ?? name).trim(),
    shortDescription: String(input.interface?.shortDescription ?? '').trim(),
    defaultPrompt: String(input.interface?.defaultPrompt ?? `Use $${name} for this task.`).trim(),
  }
  const totalBytes = Buffer.byteLength(skillMd) + Object.entries(references).reduce((sum, [path, value]) => sum + Buffer.byteLength(path) + Buffer.byteLength(value), 0)
  if (totalBytes > MAX_SKILL_BYTES) throw httpError('skill and references together must be at most 256 KiB', 400)
  return { name, skillMd, references, selectedTools: uniqueTools, interface: interfaceMetadata }
}

function renderToolReference(selectedTools, catalog) {
  const selected = new Set(selectedTools.map(item => `${item.server}:${item.tool}`))
  const sections = []
  for (const server of catalog?.servers ?? []) {
    for (const tool of server.tools ?? []) {
      if (!selected.has(`${server.id}:${tool.name}`)) continue
      sections.push(`## ${server.id}.${tool.name}\n\n${tool.description || 'No description provided.'}\n\n\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\``)
    }
  }
  return `# Generated MCP Tool Reference\n\nGenerated from MCP tools/list. Do not edit this generated file.\n\n${sections.join('\n\n')}\n`
}

async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, path)
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function collectReferences(root, relative = '') {
  const result = {}
  let entries
  try { entries = await readdir(join(root, relative), { withFileTypes: true }) } catch (error) {
    if (error?.code === 'ENOENT') return result
    throw error
  }
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name
    if (entry.isDirectory()) Object.assign(result, await collectReferences(root, path))
    else if (entry.isFile() && entry.name.endsWith('.md')) result[path] = await readFile(join(root, path), 'utf8')
  }
  return result
}

export function validateSkillSnapshot(snapshot, catalog) {
  const issues = []
  let parsed
  try { parsed = parseSkillFrontmatter(snapshot.skillMd) } catch (error) {
    issues.push({ severity: 'error', code: 'invalid_frontmatter', message: error.message })
  }
  if (parsed) {
    const keys = Object.keys(parsed.metadata)
    for (const key of keys.filter(key => !['name', 'description'].includes(key))) {
      issues.push({ severity: 'error', code: 'unsupported_frontmatter_key', message: `unsupported frontmatter key: ${key}` })
    }
    if (parsed.metadata.name !== snapshot.name) issues.push({ severity: 'error', code: 'name_mismatch', message: 'frontmatter name must match the skill name' })
    if (!parsed.metadata.description) issues.push({ severity: 'error', code: 'missing_description', message: 'frontmatter description is required' })
    if (!parsed.body.trim()) issues.push({ severity: 'error', code: 'empty_body', message: 'SKILL.md body must not be empty' })
    for (const match of parsed.body.matchAll(/\]\(references\/([^)]+)\)/g)) {
      if (!(match[1] in snapshot.references) && match[1] !== 'mcp-tools.generated.md') {
        issues.push({ severity: 'error', code: 'missing_reference', message: `missing reference file: ${match[1]}` })
      }
    }
  }
  const available = new Set((catalog?.servers ?? []).flatMap(server =>
    (server.tools ?? []).map(tool => `${server.id}:${tool.name}`),
  ))
  for (const item of snapshot.selectedTools) {
    if (!available.has(`${item.server}:${item.tool}`)) {
      issues.push({ severity: 'error', code: 'unknown_tool', message: `MCP tool is unavailable or does not exist: ${item.server}.${item.tool}` })
    }
  }
  if (snapshot.selectedTools.length === 0) issues.push({ severity: 'warning', code: 'no_tools_selected', message: 'no MCP tools are declared for this skill' })
  const shortLength = [...snapshot.interface.shortDescription].length
  if (shortLength < 25 || shortLength > 64) issues.push({ severity: 'error', code: 'invalid_short_description', message: 'interface.shortDescription must contain 25-64 characters' })
  if (!snapshot.interface.defaultPrompt.includes(`$${snapshot.name}`)) issues.push({ severity: 'error', code: 'invalid_default_prompt', message: `interface.defaultPrompt must mention $${snapshot.name}` })
  return { valid: !issues.some(item => item.severity === 'error'), issues }
}

export class SkillStore {
  constructor(root) {
    this.root = root
    this.locks = new Map()
  }

  async initialize() { await mkdir(this.root, { recursive: true }) }
  metadataPath(name) { return join(this.root, safeName(name), 'metadata.json') }
  revisionRoot(name, revision) { return join(this.root, safeName(name), 'revisions', String(revision)) }

  async #locked(name, operation) {
    const previous = this.locks.get(name) ?? Promise.resolve()
    let release
    const current = new Promise(resolve => { release = resolve })
    const queued = previous.then(() => current)
    this.locks.set(name, queued)
    await previous
    try { return await operation() } finally {
      release()
      if (this.locks.get(name) === queued) this.locks.delete(name)
    }
  }

  async #metadata(name) {
    try { return await readJson(this.metadataPath(name)) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async #writeRevision(snapshot, revision, catalog) {
    const root = this.revisionRoot(snapshot.name, revision)
    await mkdir(join(root, 'references'), { recursive: true })
    await writeFile(join(root, 'SKILL.md'), snapshot.skillMd, { mode: 0o600 })
    for (const [path, content] of Object.entries(snapshot.references)) {
      const target = join(root, 'references', path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, content, { mode: 0o600 })
    }
    await writeFile(join(root, 'references', 'mcp-tools.generated.md'), renderToolReference(snapshot.selectedTools, catalog), { mode: 0o600 })
    await atomicWriteJson(join(root, 'authoring.json'), {
      selectedTools: snapshot.selectedTools, interface: snapshot.interface,
    })
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true })
    const skills = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !NAME_PATTERN.test(entry.name)) continue
      const metadata = await this.#metadata(entry.name)
      if (metadata) skills.push(metadata)
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name))
  }

  async get(name, revision) {
    const metadata = await this.#metadata(name)
    if (!metadata) return undefined
    const selectedRevision = revision ?? metadata.currentRevision
    if (!Number.isInteger(selectedRevision) || !metadata.revisions.includes(selectedRevision)) return undefined
    const root = this.revisionRoot(name, selectedRevision)
    const authoring = await readJson(join(root, 'authoring.json'))
    return {
      ...metadata, revision: selectedRevision,
      skillMd: await readFile(join(root, 'SKILL.md'), 'utf8'),
      references: await collectReferences(join(root, 'references')),
      selectedTools: authoring.selectedTools,
      interface: authoring.interface,
    }
  }

  async create(input, catalog) {
    const snapshot = normalizeInput(input)
    return this.#locked(snapshot.name, async () => {
      if (await this.#metadata(snapshot.name)) throw httpError('skill already exists', 409)
      const now = new Date().toISOString()
      await this.#writeRevision(snapshot, 1, catalog)
      const metadata = {
        name: snapshot.name, currentRevision: 1, publishedRevision: null,
        revisions: [1], createdAt: now, updatedAt: now, publishedAt: null,
      }
      await atomicWriteJson(this.metadataPath(snapshot.name), metadata)
      return this.get(snapshot.name)
    })
  }

  async update(name, input, catalog) {
    const skillName = safeName(name)
    const snapshot = normalizeInput(input, skillName)
    return this.#locked(skillName, async () => {
      const metadata = await this.#metadata(skillName)
      if (!metadata) throw httpError('skill not found', 404)
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision !== metadata.currentRevision) {
        throw httpError(`expectedRevision must equal current revision ${metadata.currentRevision}`, 409)
      }
      const revision = metadata.currentRevision + 1
      await this.#writeRevision(snapshot, revision, catalog)
      metadata.currentRevision = revision
      metadata.revisions.push(revision)
      metadata.updatedAt = new Date().toISOString()
      await atomicWriteJson(this.metadataPath(skillName), metadata)
      return this.get(skillName)
    })
  }

  async publish(name, revision, catalog) {
    const skillName = safeName(name)
    return this.#locked(skillName, async () => {
      const metadata = await this.#metadata(skillName)
      if (!metadata) throw httpError('skill not found', 404)
      const selectedRevision = revision ?? metadata.currentRevision
      const snapshot = await this.get(skillName, selectedRevision)
      if (!snapshot) throw httpError('skill revision not found', 404)
      const validation = validateSkillSnapshot(snapshot, catalog)
      if (!validation.valid) throw Object.assign(httpError('skill validation failed', 422), { details: validation })
      metadata.publishedRevision = selectedRevision
      metadata.publishedAt = new Date().toISOString()
      metadata.updatedAt = metadata.publishedAt
      await atomicWriteJson(this.metadataPath(skillName), metadata)
      return { skill: await this.get(skillName, selectedRevision), validation }
    })
  }

  async rollback(name, revision, catalog) { return this.publish(name, revision, catalog) }
}
