-- v2（2026-10-18）：价格 ÷ PE 推算的盈利增长改存单独的 *_DERIVED 指标，只作参考
-- （docs/hengcang_v2_allocation_fundamentals_thesis.md §2）。v1 把它和成分股财报汇总口径
-- 写在同一个 EARNINGS_GROWTH / INDEX_EARNINGS_GROWTH 里，评分时两种口径交替出现在同一条历史序列。
UPDATE `metric_observations`
SET `metric_key` = 'EARNINGS_GROWTH_DERIVED'
WHERE `metric_key` = 'EARNINGS_GROWTH' AND `provider` = 'tushare-derived';
--> statement-breakpoint
UPDATE `metric_observations`
SET `metric_key` = 'INDEX_EARNINGS_GROWTH_DERIVED'
WHERE `metric_key` = 'INDEX_EARNINGS_GROWTH' AND `provider` = 'tushare-derived';
