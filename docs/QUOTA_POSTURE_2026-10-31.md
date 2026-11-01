# Quota posture — 2026-10-31 (corrected 2026-11-01)

Status: **operating decision.** The 2026-10-31 version assumed one OpenRouter
account; that premise was measured false on 2026-11-01. The Arena runs on **two
independent free-tier accounts**, pinned one per team. A third account or paid
credit remains an explicit owner decision.

## Correction — 2026-11-01

The earlier version said `OPEN_ROUTER_API_KEY_1/2` were "a rate-limit spread
inside that account, not a second cap." That was wrong.

Measured with `GET https://openrouter.ai/api/v1/key` on 2026-11-01 (UTC):

| signal | key 1 | key 2 |
|---|---|---|
| `creator_user_id` (sha256 prefix) | `dd3e918c` | `22aca750` |
| `workspace_id` (sha256 prefix) | `867d952c` | `0546183d` |
| `free_model_daily_requests` (same UTC day) | 8 / 50 used | 0 / 50 used |
| `is_free_tier` | true | true |

Different creator ids and workspaces, with independent daily counters on the
same UTC day, are two accounts — not two keys on one account. The table shows
the same SHA-256 prefixes `quota_probe.mjs` prints; raw account and workspace
ids are not published. Reproduce the check without printing key values:

```bash
npm run quota:probe        # add --json for machine output
```

`scripts/quota_probe.mjs` prints the masked key label, a hash prefix of the
account/workspace ids, and the daily counter. It never prints the key.

### Consequences

- **Capacity is 2 × 50 = 100 free requests/day**, not 50.
- **Pin, don't pool.** Alpha spends `OPEN_ROUTER_API_KEY` (account 1); beta
  spends `OPEN_ROUTER_API_KEY_2` (account 2). `openRouterKeyForTeam` and the
  workflow's `TEAM_KEY_PIN` are the two sides of that pin;
  `openRouterAccountForTeam` is the single mapping used for hold attribution.
- **No cross-account failover on quota death.** The workflow vetoes it on
  purpose: `FALLBACK_KEY` is the other team's account, so retrying a spent cap
  there would spend the other team's day. Each team waits for its own UTC
  reset; the other team keeps building.
- **A hold is per account.** One team's hold does not mean the arena is out of
  budget. `/headroom.quota_posture` reports distinct accounts and
  same-day-both-accounts, not just a raw hold count.

The Worker secret list contains both `OPEN_ROUTER_API_KEY` and
`OPEN_ROUTER_API_KEY_2`, and team repos receive them through
`ensureTeamRepoSecrets`. The measurement above used the local `.env` values.
Secret values are write-only, so the deployed values are checked separately:
`GET /admin/quota/accounts` (bearer token) probes the Worker's own configured
keys and returns the same hash prefixes plus the daily counters — never the
keys. Run it after any rotation; a `SAME account` verdict means the posture is
50/day, not 100.

## Decision (2026-10-31, account premise corrected 2026-11-01)

When the free-tier probe reports a team's daily budget is gone, the product
**holds that team's dispatches** rather than improvising:

- the build turn on the spent account is deferred to the next UTC day;
- the other team's independent account keeps building;
- no blind retries, key rotation, cross-account failover, paid fallback, or
  third account;
- the event may finish the cycle with fewer turns, or with no winner if no team
  produced a buildable outcome — that is a degraded but honest result;
- the hold is visible on `/headroom`, `/alerts` and in the event's
  `paused_capacity` status, not silent.

This is a deliberate acceptance of a lower output ceiling in exchange for a
small, auditable credential surface. It is not a claim that the ceiling is
adequate.

## Revisit triggers

The owner should revisit the **pinning and capacity** posture when any of these
is true:

1. Both independent accounts hold on the same UTC day, or the same account
   holds across two consecutive cycles, even though the probe held dispatches
   correctly.
2. A cycle cannot fit its build window at all and ends with no eligible team.
3. A dead model forces a fallback that consumes a cap faster than the primary
   (measure from the workflow's quota probe, not from token counts).
4. The Arena is expected to run unattended for more than one cycle without an
   operator available to decide a hold.

## How the triggers are monitored (2026-11-01)

`GET /headroom.quota_posture` reports `quota_hold` alerts in the last 14 days:
hold count, distinct events, distinct UTC days, distinct accounts, days on
which **both** accounts held, the last hold time, and whether the revisit proxy
is due. The scheduled tick raises one `quota_posture_review` alert (deduped for
7 days) when any of these is true:

- both accounts recorded a hold on the same UTC day;
- holds span 2+ distinct events;
- holds span 3+ distinct UTC days.

`recordQuotaHold` is deduped per **team**, so alpha's hold cannot suppress
beta's; the account is recorded in `details.account` for the posture query.

This is deliberately a proxy, not proof of trigger #1. A hold means one
account's probe refused a dispatch; it does not prove a scheduled turn was
lost. The alert says "review team pinning and capacity", not "the trigger
fired". It does not rotate keys, provision a third account, add paid credit, or
change the hold. Those remain owner decisions.

## Options if the trigger fires

| option | what it buys | cost / risk |
|---|---|---|
| Third independent OpenRouter account | ~50 more requests/day | another credential to store, rotate and leak-check; three accounts to monitor; still a free tier that can change |
| Rebalance the pin (one team per account) | matches each team's actual burn | changes which team holds on a given day; no new capacity |
| Paid OpenRouter credits | removes the daily free-tier cap | violates the project's free-providers constraint unless the owner explicitly changes that constraint |
| Reduce turns per team per day | preserves a longer build window inside each cap | fewer iterations, lower build quality; already the default shape (2/day ceiling, often 1 substantive turn) |
| Accept the degraded cycle | no new credential or spend | some cycles produce no winner; must stay visible in the archive |

The second account is no longer an option: it is provisioned and pinned.
Adding a **third** account, or paid credit, is the remaining owner decision.

## Owner action

The second account was provisioned by the owner (confirmed 2026-11-01). The
remaining explicit decisions are:

- approve or decline a third independent account (only if both current accounts
  are insufficient);
- approve or decline paid credits (would change the free-providers constraint);
- supply an `ALERT_WEBHOOK_URL` if alerts should be pushed rather than pulled.

Until a decision changes them, the defaults above stand. `/alerts` raises a
`capacity_pause` warning after a hold lasts an hour, and the runbook's §B
remains the triage path. Backlog R-5 in `docs/ARENA_BACKLOG.md` tracks the
remaining capacity decision.

This is intentionally a written decision, not a code switch: the system cannot
decide to expand its own credential surface.
