/**
 * dsh-security-audit 核心类型（设计文档 §5 报告模型 / §4.1 参数契约）。
 */

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info'

export type CheckState = 'finding' | 'pass' | 'skipped' | 'error'

export type AuditCategory = 'config' | 'plugins' | 'sessions' | 'network'

export type Action =
  | 'scan_config'
  | 'scan_plugins'
  | 'scan_sessions'
  | 'scan_network'
  | 'report'
  | 'rules'

export type RiskVerdict = 'fail' | 'warning' | 'pass'

export type CoverageVerdict = 'complete' | 'incomplete'

/** 顶层 verdict：fail > incomplete > warning > pass（设计 §5.3）。 */
export type Verdict = 'fail' | 'incomplete' | 'warning' | 'pass'

export type Confidence = 'high' | 'medium' | 'low'

/** skipped 的原因分类：只有 platform/permission 会降低关键检查的 coverage。 */
export type SkipReason =
  | 'not-applicable' // 无文件/无数据，明确不适用
  | 'platform'       // 平台不支持（如 Windows ACL）
  | 'permission'     // 权限不足无法读取
  | 'budget'         // 超过资源预算
  | 'config'         // 显式未启用（如 includeSourceScan=false）

export interface Evidence {
  /** 脱敏路径：$DSH_HOME/… 或 ~/…，绝不包含绝对用户路径。 */
  path?: string
  line?: number
  /** 脱敏后的展示值（URL 截断 / 秘密永远不出现）。 */
  value?: string
  redacted?: boolean
  /** 秘密证据：类型/长度/HMAC fingerprint，完整值永不出现在输出。 */
  secretKind?: string
  secretLength?: number
  fingerprint?: string
  [k: string]: unknown
}

export interface Finding {
  severity: Severity
  code: string
  category: AuditCategory
  /** 相对/脱敏 subject，例如 `profile:web:model-discovery` 或 `profiles/web/settings.yaml`。 */
  subject: string
  evidence?: Evidence
  exposure: string
  recommendation: string
  confidence: Confidence
  ruleVersion: number
}

export interface CheckResult {
  code: string
  state: CheckState
  subject: string
  /** finding 时的规则严重度；pass/skipped/error 时为 info。 */
  severity: Severity
  evidence?: Evidence
  reason?: string
  skipReason?: SkipReason
}

export interface ScannerResult {
  checks: CheckResult[]
  findings: Finding[]
  /** 该扫描器是否因资源预算截断（发现/文件超上限）。 */
  truncated?: boolean
}

export interface RuleMeta {
  code: string
  category: AuditCategory
  severity: Severity
  description: string
  /** 'all' 或平台白名单。 */
  platforms: 'all' | NodeJS.Platform[]
  ruleVersion: number
  /** coverage-critical：error 或 platform/permission skipped 时 coverage 判 incomplete。 */
  critical: boolean
}

export interface ReportSummary {
  critical: number
  high: number
  medium: number
  low: number
  info: number
  passed: number
  skipped: number
  errors: number
}

export interface AuditReport {
  tool: 'security_audit'
  version: number
  root: string
  platform: NodeJS.Platform
  strict: boolean
  verdict: Verdict
  riskVerdict: RiskVerdict
  coverageVerdict: CoverageVerdict
  summary: ReportSummary
  findings: Finding[]
  checks: CheckResult[]
  truncated: boolean
}

export interface RuleCatalogEntry {
  code: string
  category: AuditCategory
  severity: Severity
  description: string
  platforms: 'all' | NodeJS.Platform[]
  ruleVersion: number
  critical: boolean
}

export interface RulesOutput {
  tool: 'security_audit'
  action: 'rules'
  platform: NodeJS.Platform
  rules: RuleCatalogEntry[]
}

export interface AuditParams {
  action: Action
  root?: string
  profile?: string
  strict?: boolean
  detail?: boolean
  includeSourceScan?: boolean
}

/** runAction 的宿主注入选项（测试可注入 env/home/fixedRoot/allowedRoots）。 */
export interface RunOptions {
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
  home?: string
  /** 进程启动时固定的 $DSH_HOME（realpath 后）。 */
  fixedRoot?: string
  /** 仅测试/管理员通过插件配置声明的额外允许根。模型参数不能扩大读取范围。 */
  allowedRoots?: string[]
  /** 仅插件管理员配置的 endpoint allowlist（精确匹配，无 wildcard）。 */
  allowedEndpoints?: string[]
  platform?: NodeJS.Platform
}

/** 一次执行的内部上下文：root 已解析并 containment 校验。 */
export interface AuditContext {
  action: Exclude<Action, 'rules'>
  root: string
  fixedRoot: string
  home: string
  profile?: string
  strict: boolean
  detail: boolean
  includeSourceScan: boolean
  signal: AbortSignal
  env: NodeJS.ProcessEnv
  allowedRoots: string[]
  allowedEndpoints: string[]
  deadline: number
  /** 平台（可注入用于测试）。 */
  platform: NodeJS.Platform
  redactor: import('./redact.ts').Redactor
}
