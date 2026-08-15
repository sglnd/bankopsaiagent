/**
 * 安全解析（设计 §7.1 配置解析策略）：
 * - JSON：JSON.parse；
 * - YAML：有限、只读的子集解析（嵌套 map + `- item` 列表），扁平化为
 *   dotted-key map；`!!`/`&`/`*`/`|`/`>` 等结构拒绝，降级行级扫描；
 * - 不执行任何构造器，不解析 shell 命令替换；
 * - 无法可信解析 → ok:false（调用方降级行级模式扫描并标记 confidence）。
 */
import type { ConfigFileKind } from './discover.ts';
export interface SafeParseResult {
    ok: boolean;
    /** 解析成功时的扁平 dotted-key 数据。 */
    data?: Record<string, unknown>;
    reason?: string;
}
export declare function parseJsonSafe(text: string): SafeParseResult;
/** .env（KEY=VALUE）解析：只读，不执行 shell 展开。 */
export declare function parseEnvSafe(text: string): SafeParseResult;
/**
 * 有限 YAML 子集解析：嵌套 map（缩进）+ `- item` 列表。
 * 输出扁平 dotted-key map（如 `server.host`、`cors.origins` 数组）。
 * 遇到不安全/不支持结构返回 ok:false。
 */
export declare function parseYamlSafe(text: string): SafeParseResult;
export declare function parseSafeByKind(text: string, kind: ConfigFileKind): SafeParseResult;
/** 从扁平数据中按 dotted key 取路径值。 */
export declare function getPath(data: Record<string, unknown>, dotted: string): unknown;
/** 遍历扁平数据所有标量值。 */
export declare function scalarValues(data: Record<string, unknown>): Generator<[string, unknown]>;
