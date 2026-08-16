# 巡检判定规则

## 健康状态

- `CRITICAL`：存在未恢复的 critical/high 告警；关键服务不可用；关键指标达到 critical 阈值；或关键硬依赖同时出现明确故障证据。
- `WARNING`：存在 open/acknowledged 的 medium 告警；指标越过 warning 阈值；关键容量利用率持续高于 75%；关键组件出现明显退化或单点风险。
- `HEALTHY`：核心资产清单完整，关键 CI 具备告警和指标覆盖，窗口内无未恢复高风险告警，性能和容量未越过 warning 阈值。
- `UNDETERMINED`：系统不存在、CMDB 核心关系不完整、关键组件缺少告警或指标覆盖，导致无法可靠判定。

若多条规则命中，使用最严重状态。

## 健康评分

从 100 分开始扣减，最低为 0：

- open critical 告警：每条 -35；open high：每条 -25。
- acknowledged high：每条 -18；open/acknowledged medium：每条 -10。
- 关键指标达到 critical 阈值：每项 -25；越过 warning 阈值：每项 -10。
- 关键容量持续超过 85%：每项 -20；超过 75%：每项 -10。
- mission_critical CI 没有指标覆盖：每项 -12；high CI 没有指标覆盖：每项 -6。
- 明确单点或同故障域集中：每项 -10。

去重同一根因的告警和指标扣分，并在报告中说明评分构成。评分仅用于排序，状态以证据规则为准。

## 容量分类

名称包含 `utilization`、`usage`、`storage`、`filesystem`、`memory`、`disk`、`connection`、`lag`、`queue`、`replica` 的指标优先作为容量或余量证据。结合单位与阈值解释，不可仅凭名称断言。

