import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export class TaskStore {
  constructor(root) {
    this.root = root
  }

  async initialize() {
    await mkdir(this.root, { recursive: true })
  }

  path(id) {
    if (!/^cia_[0-9a-f-]{36}$/.test(id)) throw new TypeError('invalid analysis id')
    return join(this.root, `${id}.json`)
  }

  async save(task) {
    const path = this.path(task.id)
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(task, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  }

  async get(id) {
    try {
      return JSON.parse(await readFile(this.path(id), 'utf8'))
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw error
    }
  }

  async list() {
    const entries = await readdir(this.root, { withFileTypes: true })
    const tasks = []
    for (const entry of entries) {
      if (!entry.isFile() || !/^cia_[0-9a-f-]{36}\.json$/.test(entry.name)) continue
      tasks.push(JSON.parse(await readFile(join(this.root, entry.name), 'utf8')))
    }
    return tasks
  }
}
