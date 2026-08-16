/**
 * 配置文件发现（设计 §7.1 目标文件）：按存在性发现，不硬编码只有一种布局。
 * 只读；lstat 拒绝 symlink；显式计数预算。
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { LIMITS } from '../limits.js';
import { lstatSafe, throwIfAborted, throwIfDeadlineExceeded } from '../paths.js';
const SETTINGS_NAMES = ['settings.yaml', 'settings.yml', 'settings.json'];
const CREDENTIALS_RE = /^credentials(?:\.(?:ya?ml|json|toml|env))?$/i;
const CONFIG_NAMES = ['config.yaml', 'config.yml', 'config.json'];
const SECRETISH_RE = /credential|secret|token|api[_-]?key|auth/i;
function classifyName(name) {
    if (name === '.env' || name === 'env')
        return 'env';
    if (SETTINGS_NAMES.includes(name.toLowerCase()))
        return 'settings';
    if (CREDENTIALS_RE.test(name))
        return 'credentials';
    if (CONFIG_NAMES.includes(name.toLowerCase()))
        return 'config';
    if (name === 'package.json')
        return 'package';
    if (name === 'cordis.patch.yml' || name === 'cordis.yml')
        return 'patch';
    if (SECRETISH_RE.test(name))
        return 'credentials';
    return 'other';
}
async function collectDir(dir, root, out, state, signal, deadline) {
    const warnings = [];
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch (error) {
        warnings.push(`cannot read directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
        return warnings;
    }
    for (const entry of entries) {
        throwIfAborted(signal);
        throwIfDeadlineExceeded(deadline, signal);
        if (state.count >= LIMITS.configFiles) {
            state.truncated = true;
            break;
        }
        const full = path.join(dir, entry.name);
        const stat = await lstatSafe(full);
        if (stat === null)
            continue;
        if (stat.isSymbolicLink())
            continue; // 拒绝 symlink/reparse escape
        if (!stat.isFile())
            continue;
        const kind = classifyName(entry.name);
        out.push({ path: full, rel: path.relative(root, full).replace(/\\/g, '/'), kind, bytes: stat.size });
        state.count++;
    }
    return warnings;
}
/** 发现 root 与 root/profiles/* 下的配置文件；预算 LIMITS.configFiles。 */
export async function discoverConfigFiles(root, opts = { deadline: Number.POSITIVE_INFINITY }) {
    const maxFiles = opts.maxFiles ?? LIMITS.configFiles;
    const state = { count: 0, truncated: false };
    const files = [];
    const warnings = [];
    const rootStat = await lstatSafe(root);
    if (rootStat === null || !rootStat.isDirectory()) {
        return { files: [], truncated: false, warnings: [`root does not exist: ${root}`] };
    }
    warnings.push(...await collectDir(root, root, files, state, opts.signal, opts.deadline));
    // profiles/*：只进一层
    const profilesDir = path.join(root, 'profiles');
    const profilesStat = await lstatSafe(profilesDir);
    if (profilesStat !== null && profilesStat.isDirectory()) {
        let entries;
        try {
            entries = await fs.readdir(profilesDir, { withFileTypes: true });
        }
        catch (error) {
            warnings.push(`cannot read profiles dir: ${error instanceof Error ? error.message : String(error)}`);
            entries = [];
        }
        for (const p of entries) {
            throwIfAborted(opts.signal);
            throwIfDeadlineExceeded(opts.deadline, opts.signal);
            if (state.count >= maxFiles) {
                state.truncated = true;
                break;
            }
            if (opts.profile !== undefined && p.name !== opts.profile)
                continue;
            const pStat = await lstatSafe(path.join(profilesDir, p.name));
            if (pStat === null || !pStat.isDirectory() || pStat.isSymbolicLink())
                continue;
            warnings.push(...await collectDir(path.join(profilesDir, p.name), root, files, state, opts.signal, opts.deadline));
        }
    }
    return { files, truncated: state.truncated, warnings };
}
