/**
 * 路径工具（设计文档 §8 权限与平台策略 / §4.1 路径契约）。
 *
 * 所有发现路径执行 lstat → realpath → containment；symlink/reparse 拒绝；
 * 读取前用 lstat 限制单文件大小（fs.readFile 发起后无法立即取消）。
 */
import type { Stats } from 'node:fs';
export declare class PathEscapeError extends Error {
    readonly name = "PathEscapeError";
}
export declare class PathNotFoundError extends Error {
    readonly name = "PathNotFoundError";
}
export declare class AuditAbortedError extends Error {
    readonly name = "AuditAbortedError";
}
export declare class AuditTimeoutError extends Error {
    readonly name = "AuditTimeoutError";
}
/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export declare function resolveDshHome(env?: NodeJS.ProcessEnv): string;
export declare function throwIfAborted(signal: AbortSignal | undefined): void;
export declare function throwIfDeadlineExceeded(deadline: number, signal: AbortSignal | undefined): void;
/** 字符串级 containment（不 realpath）；win32 大小写不敏感。 */
export declare function isWithinPath(parent: string, child: string, win?: boolean): boolean;
export declare function lstatSafe(p: string): Promise<Stats | null>;
export declare function realpathSafe(p: string): Promise<string | null>;
export interface ResolvedPath {
    real: string;
    stat: Stats;
}
/**
 * lstat → realpath → containment。
 * - symlink/reparse point 一律拒绝（设计：拒绝 symlink/reparse escape）；
 * - realpath 后必须落在 base 之内。
 */
export declare function resolveContained(base: string, candidate: string, signal?: AbortSignal): Promise<ResolvedPath>;
/** 字符串级 containment 校验（candidate 不存在时也可用，用于配置中的 link/patch/root 字段）。 */
export declare function assertWithin(base: string, candidate: string, win?: boolean): void;
export type ReadResult = {
    kind: 'ok';
    buf: Buffer;
} | {
    kind: 'too-large';
    size: number;
} | {
    kind: 'missing';
} | {
    kind: 'error';
    message: string;
};
/**
 * 限尺寸读取：先 lstat 再读（发起后无法取消），超限不读取并返回 too-large。
 * 只读，绝不修改文件。
 */
export declare function readFileCapped(p: string, maxBytes: number, signal?: AbortSignal): Promise<ReadResult>;
/** 受限读取文件头部（stage-1 分析用，不整读）。 */
export declare function readHeadCapped(p: string, maxBytes: number, signal?: AbortSignal): Promise<ReadResult>;
