/**
 * DSH 本机安全审计插件（tool-bundle，只读诊断）。
 *
 * 注册 `security_audit` 工具：scan_config / scan_plugins / scan_sessions /
 * scan_network / report / rules 六个 action，输出脱敏、可复现、可定位的风险报告。
 *
 * 安全边界（设计文档 §2/§6/§8/§9）：
 * - 只读：绝不修改/删除被扫描文件，不执行插件，不连接远程；
 * - 秘密完整值永不出现在 canonical 输出（类型/长度/HMAC fingerprint/路径/行号）；
 * - 所有路径 lstat → realpath → containment；symlink/reparse escape 拒绝；
 * - root 固定为进程启动时解析的 $DSH_HOME，模型参数不能扩大读取范围
 *   （allowedRoots 只能来自插件配置）；
 * - 文件数/字节/并发/finding/输出全部有预算，timeoutMs 30s（cooperative）；
 * - capability finding 只提示人工确认用途，不裁定恶意。
 *
 * 接入方式：cordis.yml 追加
 *   - id: security-audit
 *     name: '@deepseek-ai/dsh-security-audit'
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import { runAction } from './runner.ts'
import type { AuditParams } from './types.ts'

export const name = '@deepseek-ai/dsh-security-audit'
export const inject = ['tools']

export interface SecurityAuditConfig {
  /** 仅测试/管理员声明：允许作为 root 扫描的额外绝对路径。模型参数不能扩大读取范围。 */
  allowedRoots?: unknown
  /** 仅管理员声明：endpoint allowlist（规范化 scheme+host+port 精确匹配，无 wildcard）。 */
  allowedEndpoints?: unknown
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

export function apply(ctx: Context, config: SecurityAuditConfig = {}): unknown {
  const allowedRoots = stringList(config.allowedRoots)
  const allowedEndpoints = stringList(config.allowedEndpoints)

  const disposer = ctx.tools.register(defineTool({
    name: 'security_audit',
    description:
      'Read-only local DSH security audit. Actions: scan_config (config, profile, env/credential ' +
      'metadata; secret presence, permissions, external endpoints), scan_plugins (installed bundles, ' +
      'patch rows, source, static dangerous capabilities — capability findings require manual ' +
      'confirmation and are never a malicious verdict), scan_sessions (directory permissions, ' +
      'symlink escapes, zstd frame structure within decompression-bomb budgets), scan_network ' +
      '(listen config, URL classification, plaintext HTTP, proxy routing — never connects or probes), ' +
      'report (aggregate of the four with risk+coverage verdicts), rules (rule catalog). ' +
      'Secrets never appear in output: only type/length/HMAC fingerprint/path/line. All paths are ' +
      'realpath-containment checked; root is fixed to $DSH_HOME (or an admin-declared allowedRoot); ' +
      'includeSourceScan defaults to false. Read-only: never modifies files, never executes plugins, ' +
      'never connects to remote targets.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['scan_config', 'scan_plugins', 'scan_sessions', 'scan_network', 'report', 'rules'],
        description: 'Audit action to run.',
      },
      root: {
        type: 'string',
        description: 'Optional root override; must equal the fixed $DSH_HOME or an admin-declared allowedRoot.',
      },
      profile: {
        type: 'string',
        description: 'Limit to a single profile; simple name matching ^[A-Za-z0-9._-]{1,64}$ (no paths).',
      },
      strict: {
        type: 'boolean',
        description: 'Strict verdict mode: medium findings also fail. Default false.',
      },
      detail: {
        type: 'boolean',
        description: 'Detailed output. Default true; sensitive evidence is always redacted.',
      },
      includeSourceScan: {
        type: 'boolean',
        description: 'Enable static source capability scanning (costly, more false positives). Default false.',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: (args, exec) => {
      // execute 返回 Promise（本工具访问文件系统）；runAction 内部全程检查 exec.signal。
      // runAction 的结构化报告是 JSON 可序列化对象；defineTool 的输出契约要求 JsonValue。
      return Promise.resolve(runAction(args as AuditParams, {
        signal: exec.signal,
        allowedRoots,
        allowedEndpoints,
      }) as unknown as JsonValue)
    },
    timeoutMs: 30000,
  }))
  return disposer
}
