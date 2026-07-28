-- P2-8 (ARENA_BACKLOG.md): Cloudflare Cron Triggers have no built-in retry
-- or failure alerting, and the scheduled() handler (src/index.ts) had no
-- visibility at all for a tick that throws before reaching the self-healing
-- queue logic. Single row, updated every tick (success or failure) so
-- staleness/errors are at least visible via GET /headroom instead of
-- invisible. Apply with:
--   wrangler d1 execute arena-db --remote --file=db/schema_week8_cron_heartbeat.sql

CREATE TABLE cron_heartbeat (
    id TEXT PRIMARY KEY,
    last_tick_at DATETIME,
    last_success_at DATETIME,
    last_error TEXT
);
INSERT INTO cron_heartbeat (id, last_tick_at, last_success_at, last_error) VALUES ('singleton', NULL, NULL, NULL);
