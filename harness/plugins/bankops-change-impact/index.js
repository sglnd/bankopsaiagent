import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'bankops-change-impact'
export const inject = ['skills']

const skillUrl = new URL('./skills/change-impact-analysis/SKILL.md', import.meta.url)

/** Register the BankOps domain workflow without replacing the Harness agent loop. */
export function apply(ctx) {
  const content = readFileSync(skillUrl, 'utf8')
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')

  ctx.skills.register({
    name: 'change-impact-analysis',
    description: '分析银行生产变更的系统、依赖、资源、历史和业务影响，并输出有证据的风险等级。',
    whenToUse: '用户要求分析变更单、评估变更风险或生成变更影响报告时使用。',
    source: 'runtime',
    resourceBase: {
      kind: 'directory',
      path: dirname(fileURLToPath(skillUrl)),
    },
    content: body,
  })
}
