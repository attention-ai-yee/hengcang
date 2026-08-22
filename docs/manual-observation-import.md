# Manual CSV / JSON 指标导入

Manual 导入是无 API Key 时的完整评分数据入口。文件先经过预览校验，确认后幂等写入 `metric_observations`，随后立即构建评分输入并生成 `ScoreSnapshot`。

## CSV 格式

```csv
subject_type,subject_id,metric_key,value,unit,as_of,available_at,observed_at
ASSET_BUCKET,GOLD,REAL_YIELD_10Y,1.75,percent,2026-08-20,2026-08-20T23:59:59Z,2026-08-20T00:00:00Z
```

必填字段：

- `subject_id`：`GOLD`、`VALUE_DIVIDEND`、`TECH_GROWTH` 或 `BROAD_EQUITY`。
- `metric_key`：数据状态页面列出的统一指标名。
- `value`：有限十进制数。
- `as_of`：数据归属日期，格式为 `YYYY-MM-DD`。

可选字段：

- `subject_type`：默认 `ASSET_BUCKET`。
- `unit`：省略时使用指标目录中的默认单位。
- `available_at`：省略时使用 `as_of` 当日结束时间。财务和宏观数据应优先填写真实发布日期。
- `observed_at`：省略时使用 `as_of` 当日开始时间。

## JSON 格式

可以直接使用数组，或使用 `rows` 包装：

```json
{
  "rows": [
    {
      "subjectId": "BROAD_EQUITY",
      "metricKey": "PE_TTM",
      "value": 13.2,
      "unit": "ratio",
      "asOf": "2026-08-20",
      "availableAt": "2026-08-20T23:59:59Z"
    }
  ]
}
```

## 幂等与选源规则

同一 `资产桶 + 指标 + as_of` 的 Manual 数据重复提交时更新原记录，不产生重复行。评分读取顺序固定为：

```text
手工覆盖 > 主 Provider > 后备 Provider
```

评估日为 `T` 时，只使用 `as_of <= T` 且 `available_at <= T` 的观察值。纯手工数据即使历史完整也标记为 `LOW` confidence，禁止输出增配状态。

## 价格数据

导入 `PRICE_CLOSE` 历史后，系统本地派生：

- MA20、MA60、MA200；
- 三个月与六个月动量；
- 价格相对 MA200 偏离。

日线至少需要 200 条记录才能得到完整均线结构；历史不足三年时评分仍可生成，但 confidence 为 `LOW`。
