-- Self-heal drill (2026-08-06): simulate the exact 08-02 false-abandonment
-- shape — an ideathon in day-gated deep_research whose phase work all
-- completed, then wrongly abandoned by the (pre-fix) watchdog. The next cron
-- tick should auto-revive it via reconcileAbandonedEvents. Cleaned up after
-- verification.

INSERT INTO archive_events (id, type, start_date, status, created_at, abandoned_at, abandoned_reason)
VALUES ('event_selfheal_drill_0001', 'ideathon', '2026-08-06 15:00:00', 'deep_research', datetime('now'), datetime('now'), 'Drill: simulated false abandonment');

INSERT INTO event_queue (event_id, agent_id, task_type, payload, status, scheduled_for, completed_at)
VALUES
('event_selfheal_drill_0001', 'agent_alex',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_blake', 'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_casey', 'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_drew',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_ellis', 'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_finn',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_gale',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_hale',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_iris',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_jade',  'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_kai',   'research', '{}', 'completed', datetime('now'), datetime('now')),
('event_selfheal_drill_0001', 'agent_leo',   'research', '{}', 'completed', datetime('now'), datetime('now'));
