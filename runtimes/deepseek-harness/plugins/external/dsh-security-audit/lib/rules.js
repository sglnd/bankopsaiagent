/**
 * 规则目录（设计文档 §7 规则表）。
 * severity/ruleVersion/critical 是规则的静态属性；具体检查可在此基础上下调
 * （例如 credential-file-permissions 的 group-read 记 medium）。
 */
const spec = [
    // ---- scan_config（§7.1）----
    { code: 'secret-in-settings', category: 'config', severity: 'high', description: '非 credentials 文件出现疑似 token/key/private key', critical: true },
    { code: 'credential-file-permissions', category: 'config', severity: 'high', description: '凭据文件被其他用户/组读取；平台能力不足则 skipped', critical: true },
    { code: 'plaintext-external-endpoint', category: 'network', severity: 'high', description: '凭据相关 endpoint 使用外部明文 HTTP', critical: true },
    { code: 'external-credential-target', category: 'network', severity: 'high', description: '可能携带凭据的 URL 指向非 loopback/未允许目标', critical: true },
    { code: 'env-expansion-missing', category: 'config', severity: 'medium', description: '配置引用的必需环境变量缺失，可能触发异常或意外 fallback' },
    { code: 'profile-path-outside-root', category: 'config', severity: 'high', description: 'link/patch/root 指向预期根之外', critical: true },
    { code: 'inline-private-key', category: 'config', severity: 'critical', description: '发现私钥 PEM 头或高置信秘密格式', critical: true },
    { code: 'unknown-config-format', category: 'config', severity: 'info', description: '文件存在但无法安全解析' },
    // ---- scan_plugins（§7.2）----
    { code: 'plugin-unresolved', category: 'plugins', severity: 'high', description: '声明插件无法解析', critical: true },
    { code: 'plugin-path-outside-root', category: 'plugins', severity: 'high', description: 'client/plugin entry 逃逸允许根', critical: true },
    { code: 'plugin-unpinned-git', category: 'plugins', severity: 'medium', description: 'Git 来源未固定 commit' },
    { code: 'plugin-workspace-runtime', category: 'plugins', severity: 'medium', description: '运行依赖 sibling checkout/workspace link' },
    { code: 'plugin-package-mismatch', category: 'plugins', severity: 'high', description: 'patch name 与 package name 不一致', critical: true },
    { code: 'duplicate-row-id', category: 'plugins', severity: 'medium', description: 'profile 组合有重复 row id', critical: true },
    { code: 'dynamic-code-execution', category: 'plugins', severity: 'high', description: '源码出现 eval/new Function/vm 等高风险能力' },
    { code: 'process-execution-capability', category: 'plugins', severity: 'medium', description: 'child_process/worker/process spawn 能力' },
    { code: 'network-capability', category: 'plugins', severity: 'medium', description: 'net/http/https/fetch/websocket 能力' },
    { code: 'undeclared-runtime-file', category: 'plugins', severity: 'medium', description: 'lib 运行时引用未包含在 package files/exports' },
    { code: 'install-script', category: 'plugins', severity: 'medium', description: 'preinstall/install/postinstall 执行脚本' },
    { code: 'secret-like-file', category: 'plugins', severity: 'high', description: '插件包中携带 .env/key/pem 等' },
    // ---- scan_sessions（§7.3）----
    { code: 'session-root-permissions', category: 'sessions', severity: 'high', description: '会话目录权限过宽', critical: true },
    { code: 'session-file-permissions', category: 'sessions', severity: 'medium', description: '会话文件可被其他主体读取' },
    { code: 'session-symlink', category: 'sessions', severity: 'high', description: 'sessions 下出现 symlink/reparse escape', critical: true },
    { code: 'session-non-zstd', category: 'sessions', severity: 'low', description: '预期 zstd 位置出现异常文件' },
    { code: 'session-torn-frame', category: 'sessions', severity: 'medium', description: 'zstd frame 截断' },
    { code: 'session-suspicious-expansion', category: 'sessions', severity: 'high', description: '元数据或有限解码显示异常展开比例', critical: true },
    { code: 'session-oversized-frame', category: 'sessions', severity: 'medium', description: '单帧超预算' },
    { code: 'session-temp-residue', category: 'sessions', severity: 'low', description: '临时/残留文件' },
    // ---- scan_network（§7.4）----
    { code: 'listen-all-interfaces', category: 'network', severity: 'high', description: '服务监听 0.0.0.0 / :: 且无认证证据', critical: true },
    { code: 'plaintext-http-external', category: 'network', severity: 'high', description: '外部目标使用明文 HTTP', critical: true },
    { code: 'proxy-credential-route', category: 'network', severity: 'medium', description: '代理可能接管带凭据请求' },
    { code: 'external-model-discovery', category: 'network', severity: 'high', description: 'model discovery 指向非允许目标且可能带 credential', critical: true },
    { code: 'weak-cors', category: 'network', severity: 'medium', description: '允许任意 origin 且存在敏感接口' },
    { code: 'missing-auth-on-exposed-service', category: 'network', severity: 'high', description: '非 loopback 暴露且明确未配置认证', critical: true },
    { code: 'unknown-listener-state', category: 'network', severity: 'info', description: '无法确定实际绑定状态' },
];
export const RULES = spec.map((r) => ({
    code: r.code,
    category: r.category,
    severity: r.severity,
    description: r.description,
    platforms: r.platforms ?? 'all',
    ruleVersion: r.ruleVersion ?? 1,
    critical: r.critical ?? false,
}));
export const RULE_BY_CODE = new Map(RULES.map((r) => [r.code, r]));
export const SEVERITY_RANK = {
    critical: 0,
    high: 1,
    medium: 2,
    low: 3,
    info: 4,
};
