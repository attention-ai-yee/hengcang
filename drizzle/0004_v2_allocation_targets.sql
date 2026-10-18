-- v2 战略仓位（2026-10-18）：权益 60%，其中海外权益 25%（docs/hengcang_v2_allocation_fundamentals_thesis.md §1）。
-- 只改写「全部目标行仍是 v1 默认值」的组合（设置页至今只读，现有组合基本都是这种情况）；
-- 目标改过的组合只补一行海外权益（目标 0%、上限 35%），原有比例保持不动。
CREATE TEMP TABLE `v2_untouched_portfolios` AS
SELECT `portfolio_id` FROM `allocation_targets`
GROUP BY `portfolio_id`
HAVING SUM(CASE
  WHEN `asset_bucket` = 'CASH_BONDS' AND `target_bps` = 3000 AND `min_bps` = 2000 AND `max_bps` = 4000 THEN 0
  WHEN `asset_bucket` = 'GOLD' AND `target_bps` = 1000 AND `min_bps` = 500 AND `max_bps` = 1500 THEN 0
  WHEN `asset_bucket` = 'VALUE_DIVIDEND' AND `target_bps` = 2500 AND `min_bps` = 1500 AND `max_bps` = 3500 THEN 0
  WHEN `asset_bucket` = 'TECH_GROWTH' AND `target_bps` = 3000 AND `min_bps` = 2000 AND `max_bps` = 4000 THEN 0
  WHEN `asset_bucket` = 'BROAD_EQUITY' AND `target_bps` = 500 AND `min_bps` = 0 AND `max_bps` = 1500 THEN 0
  WHEN `asset_bucket` = 'OTHER' AND `target_bps` = 0 AND `min_bps` = 0 AND `max_bps` = 1000 THEN 0
  ELSE 1
END) = 0;
--> statement-breakpoint
UPDATE `allocation_targets`
SET `target_bps` = 2000, `min_bps` = 1000, `max_bps` = 3000, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `asset_bucket` = 'VALUE_DIVIDEND' AND `portfolio_id` IN (SELECT `portfolio_id` FROM `v2_untouched_portfolios`);
--> statement-breakpoint
UPDATE `allocation_targets`
SET `target_bps` = 1500, `min_bps` = 500, `max_bps` = 2500, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `asset_bucket` = 'TECH_GROWTH' AND `portfolio_id` IN (SELECT `portfolio_id` FROM `v2_untouched_portfolios`);
--> statement-breakpoint
UPDATE `allocation_targets`
SET `target_bps` = 0, `min_bps` = 0, `max_bps` = 1000, `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE `asset_bucket` = 'BROAD_EQUITY' AND `portfolio_id` IN (SELECT `portfolio_id` FROM `v2_untouched_portfolios`);
--> statement-breakpoint
INSERT OR IGNORE INTO `allocation_targets`
  (`id`, `portfolio_id`, `asset_bucket`, `target_bps`, `min_bps`, `max_bps`, `created_at`, `updated_at`)
SELECT
  CASE WHEN `portfolio_id` = 'default' THEN 'target-overseas_equity' ELSE 'target-overseas_equity-' || `portfolio_id` END,
  `portfolio_id`,
  'OVERSEAS_EQUITY',
  CASE WHEN `portfolio_id` IN (SELECT `portfolio_id` FROM `v2_untouched_portfolios`) THEN 2500 ELSE 0 END,
  CASE WHEN `portfolio_id` IN (SELECT `portfolio_id` FROM `v2_untouched_portfolios`) THEN 1500 ELSE 0 END,
  3500,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT DISTINCT `portfolio_id` FROM `allocation_targets`);
--> statement-breakpoint
DROP TABLE `v2_untouched_portfolios`;
