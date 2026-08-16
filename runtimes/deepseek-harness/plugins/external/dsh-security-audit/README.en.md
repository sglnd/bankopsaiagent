# dsh-security-audit

[中文](README.md)

DSH local security audit plugin — defensive, read-only security auditing: configuration, credential storage metadata, installed plugin provenance, key path permissions, session file structure, and network exposure surface. Outputs redacted, reproducible, and locatable risk reports.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Repository: [https://github.com/omdsh-dev/dsh-security-audit](https://github.com/omdsh-dev/dsh-security-audit) (public)

## Motivation

The local DSH environment holds API keys, tokens, session content, and the plugin loading boundary; misconfigurations (services listening on the public network, overly permissive credential file permissions, untrusted plugin sources, abnormal session file structures) create real risk. Existing tools do not have this perspective:

1. **`plugin-check` only performs structural/compliance checks** — it does not assess the credential exposure surface, dangerous capabilities, or path escape
2. **`session-health` only performs health diagnostics** — it does not cover source trustworthiness or security risk adjudication
3. **Manual inspection is not reproducible** — credential locations, permissions, listening ports, and plugin sources are scattered across many places; item-by-item manual checks are easily missed and cannot be archived

This plugin audits the local DSH environment read-only and outputs risk reports: **does not auto-fix, does not connect to remote endpoints, does not execute audited plugins, and does not treat "not read" as "safe"**.

## Security Model (Boundaries of the Auditor Itself)

- **Read-only**: never modifies/deletes any file, never executes the code of audited plugins, never proactively connects to remote targets
- **Secret redaction**: suspected secrets only return type / length / in-process random HMAC fingerprint / path / line number; **full values never appear in canonical output** (a design-level guarantee, not truncation)
- **Path fencing**: all paths pass lstat → realpath → containment checks; `root` is fixed to the `$DSH_HOME` resolved at process startup (or an admin-declared allowedRoot); model parameters cannot expand the read scope
- **Honest determination**: four states — finding / pass / `skipped` / `error`; `skipped` and `error` do not count as pass (coverage drops to `incomplete`); `capability findings` only prompt for human confirmation, never adjudicate malice
- **Budgets**:
  - files ≤ 200, plugins ≤ 200, sessions ≤ 1,000, findings ≤ 1,000
  - source single file ≤ 1 MiB (cumulative ≤ 64 MiB); canonical output ≤ 2 MiB
  - 10s per action / 30s per report (deadline + AbortSignal checked throughout)
- Tool arguments are recorded in session logs; do not pass sensitive data

## Tool Declaration

Registers the `security_audit` tool (`@deepseek-ai/dsh-security-audit`, row id `security-audit`), uniformly outputting a JSON text string: every action outputs a `{ tool, version, root, platform, ... }` envelope; scan-type actions also carry `verdict`/`riskVerdict`/`coverageVerdict` and `summary`.

| action | Purpose | Output |
|---|---|---|
| `scan_config` | DSH configuration, profiles, env/credentials metadata (secret presence, permissions, external endpoints) | findings include `secretKind`/`secretLength`/`fingerprint`, no plaintext |
| `scan_plugins` | Installed plugin provenance, paths, patches, dangerous static capabilities, install scripts, secret files | `capability` findings flagged for human confirmation |
| `scan_sessions` | Session directory permissions, symlink escape, zstd frame structure (within decompression-bomb budgets) | frame-level issues located to specific files |
| `scan_network` | Listening configuration, URL classification, plaintext HTTP, proxy routing (no proactive networking) | status is configuration-level inference (`unknown-listener-state` explicitly flagged) |
| `report` | Summarizes the four scan categories | `riskVerdict` + `coverageVerdict` dual dimensions + findings summary |
| `rules` | Rule catalog and applicable platforms | rule code / severity / critical / platforms |

| Parameter | Type | Required | Description |
|---|---|---|---|
| `action` | string | ✅ | `scan_config` / `scan_plugins` / `scan_sessions` / `scan_network` / `report` / `rules` |
| `root` | string | | root override; must equal `$DSH_HOME` or an admin-declared allowedRoot |
| `profile` | string | | Restrict to a single profile (`^[A-Za-z0-9._-]{1,64}$`, paths not accepted) |
| `strict` | boolean | | strict mode: medium findings also fail. Default `false` |
| `detail` | boolean | | Detailed output. Default `true`; sensitive evidence is always redacted |
| `includeSourceScan` | boolean | | Enable static source-code capability scanning of plugins (slower, more false positives). Default `false` |

## Example Output

```json
{"tool":"security_audit","version":1,"root":"$DSH_HOME","platform":"win32","strict":false,
 "verdict":"fail","riskVerdict":"fail","coverageVerdict":"complete",
 "summary":{"critical":0,"high":1,"medium":0,"low":0},
 "findings":[{"code":"secret-in-settings","severity":"high","state":"finding",
   "evidence":{"path":"$DSH_HOME/.env","line":13,"secretKind":"api-key","secretLength":35,
               "fingerprint":"b99e1887d861d7be","redacted":true}}],
 "truncated":false}
```

## Design Highlights

- **Redaction protocol**: suspected secrets (token/key/private key/password) are immediately HMAC-fingerprinted with an in-process random key after reading; the raw value is used only for fingerprint computation and never enters canonical output; `redacted:true` is a protocol field, not a truncation hint
- **Path fencing**: all paths go through a three-step check — lstat (rejects symlinks) → realpath → containment; the `root` parameter cannot expand the read scope (strictly equal to the `$DSH_HOME` or allowedRoot resolved at startup)
- **Honest determination**: `skipped` (unsupported platform/no permission) and `error` do not count as pass, coverage drops to `incomplete`; `capability findings` (static detection of eval/network/process capabilities in source) only prompt human confirmation, never adjudicate malice
- **Decompression-bomb protection**: session zstd scanning truncates by frame budgets (single-frame size, cumulative expansion ratio); never decompresses whole packages
- **Read-only guarantee**: no file-writing paths, no subprocess execution (source capability scanning is static regex only, never runs audited plugins), no network connections (`scan_network` only parses configuration and classifies URLs, never probes)
- **Reproducible output**: no timestamps, no random path ordering (stable sorting); `truncated` is set when limits are exceeded; canonical output ≤ 2 MiB (contract assertion)

## Build and Test

```bash
# 构建（仅需 monorepo 的 tsc）
node <monorepo>/node_modules/typescript/bin/tsc -p tsconfig.json

# 测试（vitest，112 个用例：redact/paths/config/plugins/sessions/network/permissions/report/register）
node <monorepo>/node_modules/vitest/vitest.mjs run tests
```

## npm 0.1.0-rc.6 Compatibility (verified)

This plugin has been migrated to the npm 0.1.0-rc.6 dependency line, and full end-to-end verification was completed in an isolated consumer of `@deepseek-ai/dsh@0.1.0-rc.6`:

- **Types/runtime**: `@deepseek-ai/cordis@^4.0.1` + `@deepseek-ai/dsh-tools@>=0.0.1-rc.1 <0.2.0` + `@deepseek-ai/dsh-invariants@>=0.0.1-rc.1 <0.2.0` (peer); no longer depends on unscoped `cordis`
- **Standalone build**: `npm install` (devDependencies self-contain typescript/vitest/@types/node) → `npm run typecheck` → `npm test` → `npm run build` → `npm pack`
- **Consumption verification**: tarball loaded into an rc.6 consumer → the plugin's row appears in `dsh --profile compat --dump-config` → real tool registration and execution passed
- **Startup method**: `npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh web` (lib production mode; do not `install -g` globally)


## Installation

Under DSH 0.1.0-rc.6 (npm), plugins are installed via `dsh plugin --profile <profile> add <source>`; source is a GitHub repository or an npm pack tarball.

### Install from GitHub (Recommended)

```sh
# 交互式（web）profile
dsh plugin --profile web add github:omdsh-dev/dsh-security-audit
# 一次性任务（headless）profile —— dsh run 默认使用 headless
dsh plugin --profile headless add github:omdsh-dev/dsh-security-audit
```

### Install from npm pack tarball

The `npm pack` artifact can be installed directly as source:

```sh
dsh plugin --profile web add dsh-security-audit-*.tgz
```

The bundled `dsh.bundle.patch` automatically adds the plugin to the profile's layer stack after installation (row id: `security-audit`). The plugin's missing peer dependencies (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-invariants`) are provided by the profile's healed `profiles/node_modules` fallback installation.

> ⚠️ web and headless are **different profiles**: installing into web does not automatically cover headless; `dsh run` uses the headless profile by default. Use forward slashes for Windows paths (`C:/...`).

### Verifying the Installation

```sh
dsh --profile web --dump-config | grep security-audit
```

### Runtime Verification

```sh
dsh run "运行 security_audit 的 report 动作，检查本机 DSH 环境安全风险"
```

### Legacy Scenario: monorepo / Local-Path Installation

The monorepo approach is now a legacy scenario (local junction/symlink, manually editing the profile layer, legacy snapshots without GitHub/tarball source support):

```sh
dsh plugin --profile web add "C:/path/to/dsh-security-audit"
```

## License

MIT
