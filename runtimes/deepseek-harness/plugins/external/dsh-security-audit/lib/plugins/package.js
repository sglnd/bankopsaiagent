/**
 * 插件包 package.json 安全读取与来源分类（设计 §7.2 数据来源）。
 * 只读；路径 containment。
 */
import * as path from 'node:path';
import { readFileCapped, resolveContained } from '../paths.js';
import { LIMITS } from '../limits.js';
export async function readPackageSafe(dir, signal) {
    const read = await readFileCapped(path.join(dir, 'package.json'), LIMITS.configFileBytes, signal);
    if (read.kind !== 'ok')
        return null;
    try {
        const raw = JSON.parse(read.buf.toString('utf8'));
        return raw;
    }
    catch {
        return null;
    }
}
/** 依据 patch row 的 source 字段分类来源。 */
export function classifySource(source) {
    if (source === undefined || source === '')
        return { kind: 'unknown' };
    const s = source.trim();
    if (/^(git\+|git@|github:|gitlab:|bitbucket:)/.test(s) || /\.git(#|$)/.test(s)) {
        const pinned = /[#@][0-9a-fA-F]{7,40}$/.test(s) || /#v?[0-9]+\.[0-9]+/.test(s) || /@v?[0-9]+\.[0-9]+/.test(s);
        return { kind: 'git', pinned };
    }
    if (/^npm:/.test(s))
        return { kind: 'npm' };
    if (/^file:/.test(s))
        return { kind: 'file' };
    if (/^link:/.test(s))
        return { kind: 'link' };
    if (/^workspace:/.test(s))
        return { kind: 'workspace' };
    if (/^https?:\/\//.test(s) && /\.git/.test(s)) {
        return { kind: 'git', pinned: /[#@][0-9a-fA-F]{7,40}$/.test(s) };
    }
    return { kind: 'unknown' };
}
/**
 * 解析插件包位置：
 * - node_modules/<name> 下（root 或 profile dir）；
 * - file:/link:/workspace: 相对路径（containment 校验，symlink 拒绝）。
 */
export async function resolvePluginLocation(name, source, candidates, signal) {
    // 1) node_modules 常规解析
    for (const base of candidates) {
        const nm = path.join(base, 'node_modules', name);
        const resolved = await resolveContainedSafe(base, nm, signal);
        if (resolved) {
            const pkg = await readPackageSafe(resolved.real, signal);
            if (pkg)
                return { dir: resolved.real, pkg, sourceKind: 'npm' };
        }
    }
    // 2) file:/link:/workspace: 相对路径
    if (source !== undefined) {
        const m = /^(?:file|link|workspace):(.+)$/.exec(source.trim());
        if (m) {
            const target = m[1].trim();
            if (!target.startsWith('/') && !/^[a-zA-Z]:/.test(target)) {
                for (const base of candidates) {
                    const resolved = await resolveContainedSafe(base, path.resolve(base, target), signal);
                    if (resolved) {
                        const pkg = await readPackageSafe(resolved.real, signal);
                        if (pkg)
                            return { dir: resolved.real, pkg, sourceKind: source.trim().startsWith('link:') ? 'link' : source.trim().startsWith('workspace:') ? 'workspace' : 'file' };
                    }
                }
            }
        }
    }
    return null;
}
async function resolveContainedSafe(base, candidate, signal) {
    try {
        return await resolveContained(base, candidate, signal);
    }
    catch {
        return null;
    }
}
/** install script 检查：preinstall/install/postinstall。 */
export function installScripts(pkg) {
    const scripts = pkg.scripts ?? {};
    return ['preinstall', 'install', 'postinstall'].filter((k) => typeof scripts[k] === 'string' && scripts[k].trim() !== '');
}
