/**
 * action 调度、预算、汇总（设计 §5 报告模型 / §9 输出与资源限制）。
 *
 * - report 内部建立 action 级 deadline，在每个子扫描器之间检查；
 * - 超时/取消返回工具错误（抛异常），不得返回部分结果并伪称完整；
 * - 单文件大小在读取前通过 lstat 限制；
 * - findings/checks 有上限，超出置 truncated；
 * - verdict：riskVerdict + coverageVerdict 双维度（§5.3）。
 */
import { isWithinPath } from './paths.ts';
import type { AuditContext, AuditParams, AuditReport, CheckResult, CoverageVerdict, Finding, ReportSummary, RiskVerdict, RulesOutput, RunOptions, ScannerResult, Verdict } from './types.ts';
export declare class AuditArgsError extends Error {
    readonly name = "AuditArgsError";
}
export declare function buildRulesOutput(platform?: NodeJS.Platform): Promise<RulesOutput>;
export declare function computeRiskVerdict(findings: readonly Finding[], strict: boolean): RiskVerdict;
export declare function computeCoverageVerdict(checks: readonly CheckResult[]): CoverageVerdict;
export declare function computeVerdict(risk: RiskVerdict, coverage: CoverageVerdict): Verdict;
export declare function summarize(findings: readonly Finding[], checks: readonly CheckResult[]): ReportSummary;
export declare function sortFindings(findings: readonly Finding[]): Finding[];
export declare function sortChecks(checks: readonly CheckResult[]): CheckResult[];
export declare function buildReport(ctx: AuditContext, results: ScannerResult[], truncated: boolean): AuditReport;
export declare function runAction(params: AuditParams, opts?: RunOptions): Promise<AuditReport | RulesOutput>;
export { isWithinPath };
