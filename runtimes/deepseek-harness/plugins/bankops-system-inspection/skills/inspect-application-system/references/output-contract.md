# 输出契约

API 模式必须返回以下字段：

```json
{
  "schemaVersion": "1.0",
  "inspectionId": "sia_uuid",
  "serviceId": "SVC-...",
  "healthStatus": "CRITICAL | WARNING | HEALTHY | UNDETERMINED",
  "healthScore": 0,
  "summary": "结论摘要",
  "systemOverview": {},
  "inventorySummary": {},
  "applicationModules": [],
  "ipNodes": [],
  "middleware": [],
  "databases": [],
  "networkComponents": [],
  "activeAlerts": [],
  "performanceFindings": [],
  "capacityFindings": [],
  "topologyRisks": [],
  "historicalIncidents": [],
  "risks": [{"code":"","severity":"CRITICAL | HIGH | MEDIUM | LOW","description":"","evidenceRefs":[]}],
  "dataGaps": [],
  "recommendations": [],
  "evidence": [{"id":"","source":"cmdb | alertinfo | perfinfo","tool":"","ciIds":[],"fact":{}}]
}
```

`healthScore` 必须为 0 到 100 的整数。所有数组即使为空也必须保留。资产数组应至少包含 CI 标识、名称、类型、IP（若有）、状态、重要度和角色。建议按“立即处理、近期治理、监控补齐”排序。

