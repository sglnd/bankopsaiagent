/**
 * 规则目录（设计文档 §7 规则表）。
 * severity/ruleVersion/critical 是规则的静态属性；具体检查可在此基础上下调
 * （例如 credential-file-permissions 的 group-read 记 medium）。
 */
import type { RuleMeta, Severity } from './types.ts';
export declare const RULES: readonly RuleMeta[];
export declare const RULE_BY_CODE: ReadonlyMap<string, RuleMeta>;
export declare const SEVERITY_RANK: Readonly<Record<Severity, number>>;
