# dsh-security-audit

[English](README.en.md)

DSH 本机安全审计插件 —— 防御性、只读的安全审计：配置、凭据存储元数据、已安装插件来源、关键路径权限、会话文件结构与网络暴露面。输出脱敏、可复现、可定位的风险报告。

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

仓库：[https://github.com/omdsh-dev/dsh-security-audit](https://github.com/omdsh-dev/dsh-security-audit)（public）

## 动机

DSH 本地环境承载 API Key、token、会话内容和插件加载边界，误配置（服务监听公网、凭据文件权限过宽、插件来源不可信、会话文件结构异常）会造成真实风险。现有工具没有这个视角：

1. **`plugin-check` 只做结构/合规检查**——不评估凭据暴露面、危险能力和路径逃逸
2. **`session-health` 只做健康诊断**——不涉及来源可信度与安全风险裁定
3. **手工排查不可复现**——凭据位置、权限、监听端口、插件来源分散在多处，逐项人工检查极易遗漏且无法留档

本插件以只读方式审计本机 DSH 环境并输出风险报告：**不自动修复、不连接远程、不执行被审计插件、不把"没读到"当作"安全"**。

## 安全模型（审计器自身的边界）

- **只读**：绝不修改/删除任何文件，绝不执行被审计插件的代码，绝不主动连接远程目标
- **秘密脱敏**：疑似秘密只返回类型 / 长度 / 进程内随机 HMAC fingerprint / 路径 / 行号，**完整值永不出现在 canonical 输出**（设计级保证，非截断）
- **路径围栏**：所有路径经 lstat → realpath → containment 检查；`root` 固定为进程启动时解析的 `$DSH_HOME`（或管理员声明的 allowedRoot），模型参数不能扩大读取范围
- **诚实判定**：finding / pass / `skipped` / `error` 四态；`skipped` 与 `error` 不计为 pass（coverage 降为 `incomplete`）；`capability finding` 只提示人工确认、不裁定恶意
- **预算**：
  - 文件 ≤ 200、插件 ≤ 200、会话 ≤ 1,000、findings ≤ 1,000
  - 源码单文件 ≤ 1 MiB（累计 ≤ 64 MiB）；canonical 输出 ≤ 2 MiB
  - 单 action 10s / report 30s（deadline + AbortSignal 全程检查）
- 工具参数会记入会话日志，不要传入敏感数据

## 工具声明

注册 `security_audit` 工具（`@deepseek-ai/dsh-security-audit`，row id `security-audit`），统一输出 JSON 文本字符串：所有 action 输出 `{ tool, version, root, platform, ... }` 信封，扫描类 action 带 `verdict`/`riskVerdict`/`coverageVerdict` 与 `summary`。

| action | 作用 | 输出 |
|---|---|---|
| `scan_config` | DSH 配置、profile、env/credentials 元数据（秘密存在性、权限、外部端点） | findings 含 `secretKind`/`secretLength`/`fingerprint`，无明文 |
| `scan_plugins` | 已安装插件来源、路径、patch、危险静态能力、install script、秘密文件 | `capability` finding 标注人工确认 |
| `scan_sessions` | 会话目录权限、symlink 逃逸、zstd 帧结构（解压炸弹预算内） | 帧级问题定位到文件 |
| `scan_network` | 监听配置、URL 分类、明文 HTTP、代理路由（不主动联网） | 状态为配置级推断（`unknown-listener-state` 明确标注） |
| `report` | 汇总四类扫描 | `riskVerdict` + `coverageVerdict` 双维度 + findings 汇总 |
| `rules` | 规则目录与适用平台 | 规则 code / severity / critical / platforms |

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `action` | string | ✅ | `scan_config` / `scan_plugins` / `scan_sessions` / `scan_network` / `report` / `rules` |
| `root` | string | | root 覆盖；必须等于 `$DSH_HOME` 或管理员声明的 allowedRoot |
| `profile` | string | | 限定单个 profile（`^[A-Za-z0-9._-]{1,64}$`，不接受路径） |
| `strict` | boolean | | strict 模式：medium finding 也判 fail。默认 `false` |
| `detail` | boolean | | 详细输出。默认 `true`；敏感证据始终脱敏 |
| `includeSourceScan` | boolean | | 启用插件静态源码能力扫描（更慢、更多误报）。默认 `false` |

## 输出示例

```json
{"tool":"security_audit","version":1,"root":"$DSH_HOME","platform":"win32","strict":false,
 "verdict":"fail","riskVerdict":"fail","coverageVerdict":"complete",
 "summary":{"critical":0,"high":1,"medium":0,"low":0},
 "findings":[{"code":"secret-in-settings","severity":"high","state":"finding",
   "evidence":{"path":"$DSH_HOME/.env","line":13,"secretKind":"api-key","secretLength":35,
               "fingerprint":"b99e1887d861d7be","redacted":true}}],
 "truncated":false}
```

## 设计要点

- **脱敏协议**：疑似秘密（token/key/private key/密码）在读取后立即以进程内随机密钥做 HMAC fingerprint，原始值只用于指纹计算，不进 canonical 输出；`redacted:true` 是协议字段而非截断提示
- **路径围栏**：所有路径 lstat（拒绝 symlink）→ realpath → containment 三重校验；`root` 参数不能扩大读取范围（与启动时解析的 `$DSH_HOME` 或 allowedRoot 严格相等）
- **诚实判定**：`skipped`（平台不支持/无权限）与 `error` 不计为 pass，coverage 降为 `incomplete`；`capability finding`（源码静态检测到 eval/网络/进程能力）只提示人工确认，不裁定恶意
- **解压炸弹防护**：会话 zstd 扫描按帧预算（单帧大小、累计展开比）截断，不整包解压
- **只读保证**：无写文件路径、无子进程执行（源码能力扫描只做静态正则，不运行被审计插件）、无网络连接（scan_network 只解析配置与分类 URL，从不探测）
- **可复现输出**：无时间戳、无随机路径顺序（稳定排序）；超限截断后置 `truncated`；canonical 输出 ≤ 2 MiB（契约断言）

## 构建与测试

```bash
# 构建（仅需 monorepo 的 tsc）
node <monorepo>/node_modules/typescript/bin/tsc -p tsconfig.json

# 测试（vitest，112 个用例：redact/paths/config/plugins/sessions/network/permissions/report/register）
node <monorepo>/node_modules/vitest/vitest.mjs run tests
```

## npm 0.1.0-rc.6 兼容（已验证）

本插件已迁移到 npm 0.1.0-rc.6 依赖线，并在 `@deepseek-ai/dsh@0.1.0-rc.6` 的隔离 consumer 中完成全链路验证：

- **类型/运行时**：`@deepseek-ai/cordis@^4.0.1` + `@deepseek-ai/dsh-tools@>=0.0.1-rc.1 <0.2.0` + `@deepseek-ai/dsh-invariants@>=0.0.1-rc.1 <0.2.0`（peer）；不再依赖 unscoped `cordis`
- **独立构建**：`npm install`（devDependencies 自包含 typescript/vitest/@types/node）→ `npm run typecheck` → `npm test` → `npm run build` → `npm pack`
- **消费验证**：tarball 装入 rc.6 consumer → `dsh --profile compat --dump-config` 出现本插件 row → 工具真实注册与执行通过
- **启动方式**：`npx -p @deepseek-ai/dsh@0.1.0-rc.6 dsh web`（lib 生产模式；勿 `install -g` 全局安装）


## 安装

DSH 0.1.0-rc.6（npm）下，插件通过 `dsh plugin --profile <profile> add <source>` 安装，source 支持 GitHub 仓库或 npm pack tarball。

### 从 GitHub 安装（推荐）

```sh
# 交互式（web）profile
dsh plugin --profile web add github:omdsh-dev/dsh-security-audit
# 一次性任务（headless）profile —— dsh run 默认使用 headless
dsh plugin --profile headless add github:omdsh-dev/dsh-security-audit
```

### 从 npm pack tarball 安装

`npm pack` 产物可直接作为 source 安装：

```sh
dsh plugin --profile web add dsh-security-audit-*.tgz
```

包内 `dsh.bundle.patch` 会在安装后自动把插件加入 profile 的 layer stack（row id：`security-audit`）。插件缺失的 peer 依赖（`@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-invariants`）由 profile 的 healed `profiles/node_modules` 回退安装提供。

> ⚠️ web 与 headless 是**不同 profile**：web 安装不会自动覆盖 headless；`dsh run` 默认使用 headless profile。Windows 路径使用正斜杠（`C:/...`）。

### 验证安装

```sh
dsh --profile web --dump-config | grep security-audit
```

### 运行验证

```sh
dsh run "运行 security_audit 的 report 动作，检查本机 DSH 环境安全风险"
```

### 旧场景：monorepo / 本地路径安装

monorepo 方式已标注为旧场景（本地 junction/symlink、手动编辑 profile 层、不支持 GitHub/tarball source 的旧快照）：

```sh
dsh plugin --profile web add "C:/path/to/dsh-security-audit"
```

## 许可

MIT
