import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'bankops-system-inspection'
export const inject = ['skills']

const skillUrl = new URL('./skills/inspect-application-system/SKILL.md', import.meta.url)

/** Register the BankOps system inspection workflow without replacing the Harness agent loop. */
export function apply(ctx) {
  const content = readFileSync(skillUrl, 'utf8')
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

  ctx.skills.register({
    name: 'inspect-application-system',
    description: '盘点应用系统资产，并综合分析告警、性能、容量和拓扑风险，输出有证据的健康报告。',
    whenToUse: '用户要求系统巡检、应用健康检查、运行状态评估、容量检查或生成巡检报告时使用。',
    source: 'runtime',
    resourceBase: {
      kind: 'directory',
      path: dirname(fileURLToPath(skillUrl)),
    },
    content: body,
  })
}

