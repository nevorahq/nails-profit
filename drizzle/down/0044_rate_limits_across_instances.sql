-- Rollback for 0044_rate_limits_across_instances.
--
-- The table holds counters and nothing else: no tenant data, no history, and
-- nothing another table points at. Dropping it forgets which callers were near
-- their limit, which the next window would have forgotten anyway.
DROP TABLE IF EXISTS "rate_limit_window";
