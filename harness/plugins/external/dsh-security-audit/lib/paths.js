/**
 * 路径工具（设计文档 §8 权限与平台策略 / §4.1 路径契约）。
 *
 * 所有发现路径执行 lstat → realpath → containment；symlink/reparse 拒绝；
 * 读取前用 lstat 限制单文件大小（fs.readFile 发起后无法立即取消）。
 */
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
export class PathEscapeError extends Error {
    name = 'PathEscapeError';
}
export class PathNotFoundError extends Error {
    name = 'PathNotFoundError';
}
export class AuditAbortedError extends Error {
    name = 'AuditAbortedError';
}
export class AuditTimeoutError extends Error {
    name = 'AuditTimeoutError';
}
/** $DSH_HOME：优先环境变量，缺省 ~/.dsh（与官方 resolveDshHome 语义一致）。 */
export function resolveDshHome(env = process.env) {
    return env.DSH_HOME ?? path.join(homedir(), '.dsh');
}
export function throwIfAborted(signal) {
    if (signal?.aborted)
        throw new AuditAbortedError('security_audit: cancelled');
}
export function throwIfDeadlineExceeded(deadline, signal) {
    throwIfAborted(signal);
    if (Date.now() > deadline)
        throw new AuditTimeoutError('security_audit: action deadline exceeded');
}
/** 字符串级 containment（不 realpath）；win32 大小写不敏感。 */
export function isWithinPath(parent, child, win = process.platform === 'win32') {
    const norm = (s) => {
        let out = path.resolve(s).replace(/\\/g, '/').replace(/\/+/g, '/');
        if (out.length > 1 && out.endsWith('/'))
            out = out.slice(0, -1);
        if (win)
            out = out.toLowerCase();
        return out;
    };
    const a = norm(parent);
    const b = norm(child);
    if (b === a)
        return true;
    return b.startsWith(a + '/');
}
export async function lstatSafe(p) {
    try {
        return await fs.lstat(p);
    }
    catch {
        return null;
    }
}
export async function realpathSafe(p) {
    try {
        return await fs.realpath(p);
    }
    catch {
        return null;
    }
}
/**
 * lstat → realpath → containment。
 * - symlink/reparse point 一律拒绝（设计：拒绝 symlink/reparse escape）；
 * - realpath 后必须落在 base 之内。
 */
export async function resolveContained(base, candidate, signal) {
    throwIfAborted(signal);
    const stat = await lstatSafe(candidate);
    if (stat === null)
        throw new PathNotFoundError(candidate);
    if (stat.isSymbolicLink()) {
        throw new PathEscapeError(`symbolic link rejected: ${candidate}`);
    }
    if (!stat.isFile() && !stat.isDirectory()) {
        throw new PathEscapeError(`unsupported file type: ${candidate}`);
    }
    const real = await fs.realpath(candidate);
    if (!isWithinPath(base, real)) {
        throw new PathEscapeError(`path escapes allowed root: ${candidate}`);
    }
    return { real, stat };
}
/** 字符串级 containment 校验（candidate 不存在时也可用，用于配置中的 link/patch/root 字段）。 */
export function assertWithin(base, candidate, win) {
    if (!isWithinPath(base, candidate, win)) {
        throw new PathEscapeError(`path escapes allowed root: ${candidate}`);
    }
}
/**
 * 限尺寸读取：先 lstat 再读（发起后无法取消），超限不读取并返回 too-large。
 * 只读，绝不修改文件。
 */
export async function readFileCapped(p, maxBytes, signal) {
    throwIfAborted(signal);
    const stat = await lstatSafe(p);
    if (stat === null)
        return { kind: 'missing' };
    if (!stat.isFile())
        return { kind: 'error', message: 'not a regular file' };
    if (stat.size > maxBytes)
        return { kind: 'too-large', size: stat.size };
    try {
        const buf = await fs.readFile(p);
        return { kind: 'ok', buf };
    }
    catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
}
/** 受限读取文件头部（stage-1 分析用，不整读）。 */
export async function readHeadCapped(p, maxBytes, signal) {
    throwIfAborted(signal);
    const stat = await lstatSafe(p);
    if (stat === null)
        return { kind: 'missing' };
    if (!stat.isFile())
        return { kind: 'error', message: 'not a regular file' };
    try {
        const fh = await fs.open(p, 'r');
        try {
            const len = Math.min(stat.size, maxBytes);
            const buf = Buffer.alloc(len);
            await fh.read(buf, 0, len, 0);
            return { kind: 'ok', buf };
        }
        finally {
            await fh.close();
        }
    }
    catch (error) {
        return { kind: 'error', message: error instanceof Error ? error.message : String(error) };
    }
}
