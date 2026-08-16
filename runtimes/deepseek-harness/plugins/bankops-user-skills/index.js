import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

export const name = 'bankops-user-skills'
export const inject = ['skills']

function parseSkill(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content)
  if (!match) throw new Error('missing frontmatter')
  const metadata = {}
  for (const line of match[1].split(/\r?\n/)) {
    const item = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(line)
    if (!item) throw new Error(`unsupported frontmatter line: ${line}`)
    metadata[item[1]] = item[2].replace(/^['"]|['"]$/g, '').trim()
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name ?? '')) throw new Error('invalid skill name')
  if (!metadata.description) throw new Error('missing skill description')
  return { ...metadata, body: match[2] }
}

function skillRoot() {
  return process.env.BANKOPS_USER_SKILL_ROOT
    ?? join(process.env.DSH_HOME ?? '/data/dsh', 'bankops-skills')
}

/** Load only validated revisions selected by Skill Studio metadata. */
export function apply(ctx) {
  const root = skillRoot()
  if (!existsSync(root)) return
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const metadata = JSON.parse(readFileSync(join(root, entry.name, 'metadata.json'), 'utf8'))
      if (!Number.isInteger(metadata.publishedRevision)) continue
      const revisionRoot = join(root, entry.name, 'revisions', String(metadata.publishedRevision))
      const parsed = parseSkill(readFileSync(join(revisionRoot, 'SKILL.md'), 'utf8'))
      JSON.parse(readFileSync(join(revisionRoot, 'authoring.json'), 'utf8'))
      ctx.skills.register({
        name: parsed.name,
        description: parsed.description,
        whenToUse: parsed.description,
        source: 'runtime',
        resourceBase: { kind: 'directory', path: revisionRoot },
        content: parsed.body,
      })
    } catch (error) {
      console.warn(`[bankops-user-skills] skipped ${entry.name}: ${error.message}`)
    }
  }
}
