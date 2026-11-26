# Quota posture — 2026-10-31 (corrected 2026-11-01)

Status: **operating decision.** The 2026-10-31 version assumed one OpenRouter
account; that premise was measured false on 2026-11-01. Since 2026-11-27 the
Arena runs on **four independent free-tier accounts**, two per team (alpha
1/3, beta 2/4). Paid credit remains an explicit owner decision.

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

## Expansion — 2026-11-27

The owner added two more OpenRouter keys after the Nov 18–22 cycle lost every
build turn to daily quota exhaustion. Measured with the same probe on
2026-11-27 (hashes only, no key values):

| signal | key 3 | key 4 |
|---|---|---|
| `creator_user_id` (sha256 prefix) | `6eb130c8` | `7c98d5ba` |
| `workspace_id` (sha256 prefix) | `cb97fc5f` | `339cb7ed` |
| `free_model_daily_requests` | 0 / 50 used | 0 / 50 used |
| `is_free_tier` | true | true |

All four account ids are distinct, so this is four independent accounts in two
disjoint pairs. The scheduler probes **both** accounts a team owns and spends
the first with budget: alpha `1 → 3`, beta `2 → 4`. The selected pin travels in
the dispatch payload so the workflow starts on the same account. A team that
exhausts both of its accounts waits for its own UTC reset; it never borrows the
other team's pair. Capacity is now **2 × 50 = 100 per team, 200/day total**.

The Worker secrets `OPEN_ROUTER_API_KEY_3` and `_4` were set from the owner's
`.env` values on 2026-11-27; team repos receive all four through
`ensureTeamRepoSecrets`. `GET /admin/quota/accounts` probes all four slots.

### Consequences (current)

- **Capacity is 4 × 50 = 200 free requests/day**, 100 per team, not 50.
- **Pin, don't pool.** Alpha spends accounts 1 then 3; beta spends 2 then 4.
  `openRouterAccountsForTeam`, the scheduler's probe loop, and the workflow's
  `TEAM_KEY_PIN` (carried in the dispatch payload) are the three sides of that
  pin; `openRouterAccountForTeam` remains the legacy hold-attribution mapping.
- **No cross-account failover on quota death.** The workflow still vetoes a
  mid-turn failover: `FALLBACK_KEY` is the team's own overflow, but an exhausted
  day is a clean handoff and the scheduler spends that overflow on the next
  dispatch. No team ever reaches another team's accounts.
- **A hold is per team, covering both of its accounts.** One team's hold does
  not mean the arena is out of budget. `/headroom.quota_posture` reports
  distinct accounts and same-day-two-accounts, not just a raw hold count.

The Worker secret list contains all four `OPEN_ROUTER_API_KEY*` names, and team
repos receive them through `ensureTeamRepoSecrets`. Measurements used the local
`.env` values.
Secret values are write-only, so the deployed values are checked separately:
`GET /admin/quota/accounts` (bearer token) probes the Worker's own configured
keys and returns the same hash prefixes plus the daily counters — never the
keys. Run it after any rotation; a `DUPLICATE account ids` verdict means the
per-team overflow is not real capacity.

## Decision (2026-10-31, account premise corrected 2026-11-01)

When the free-tier probe reports a team's daily budget is gone, the product
**holds that team's dispatches** rather than improvising:

- the build turns on both of that team's accounts are deferred to the next UTC
  day;
- the other team's independent pair keeps building;
- no blind retries, key rotation, cross-team failover, paid fallback, or fifth
  account;
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

1. Two accounts hold on the same UTC day (a proxy for both teams being
   squeezed), or the same team holds across two consecutive cycles, even though
   the probe held dispatches correctly.
2. A cycle cannot fit its build window at all and ends with no eligible team.
3. A dead model forces a fallback that consumes a cap faster than the primary
   (measure from the workflow's quota probe, not from token counts).
4. The Arena is expected to run unattended for more than one cycle without an
   operator available to decide a hold.

## How the triggers are monitored (2026-11-01)

`GET /headroom.quota_posture` reports `quota_hold` alerts in the last 14 days:
hold count, distinct events, distinct UTC days, distinct accounts, days on
which **two** accounts held, the last hold time, and whether the revisit proxy
is due. The scheduled tick raises one `quota_posture_review` alert (deduped for
7 days) when any of these is true:

- two accounts recorded a hold on the same UTC day;
- holds span 2+ distinct events;
- holds span 3+ distinct UTC days.

`recordQuotaHold` is deduped per **team**, so alpha's hold cannot suppress
beta's; the accounts actually exhausted are recorded in `details.accounts_exhausted`
(and the primary in `details.account`) for the posture query. A team's accounts
are its own disjoint pair: alpha 1/3, beta 2/4 when key 2 is configured; with
key 2 unset beta falls back to 1/3, matching the historical shared-pool rule.

This is deliberately a proxy, not proof of trigger #1. A hold means one
account's probe refused a dispatch; it does not prove a scheduled turn was
lost. The alert says "review team pinning and capacity", not "the trigger
fired". It does not rotate keys, provision a third account, add paid credit, or
change the hold. Those remain owner decisions.

## Options if the trigger fires

| option | what it buys | cost / risk |
|---|---|---|
| Fifth independent OpenRouter account | ~50 more requests/day for one team | another credential to store, rotate and leak-check; still a free tier that can change |
| Rebalance the pin | matches each team's actual burn | changes which team holds on a given day; no new capacity |
| Paid OpenRouter credits | removes the daily free-tier cap | violates the project's free-providers constraint unless the owner explicitly changes that constraint |
| Reduce turns per team per day | preserves a longer build window inside each cap | fewer iterations, lower build quality; already the default shape (2/day ceiling, often 1 substantive turn) |
| Accept the degraded cycle | no new credential or spend | some cycles produce no winner; must stay visible in the archive |

The second account was provisioned on 2026-11-01; the third and fourth were
provisioned on 2026-11-27 after the owner added two keys. Adding a **fifth**
account, or paid credit, is the remaining owner decision.

## Owner action

The second account was provisioned by the owner (confirmed 2026-11-01), and the
third/fourth on 2026-11-27 from the two keys the owner added to `.env`. The
remaining explicit decisions are:

- approve or decline a fifth independent account (only if both two-account pairs
  are insufficient);
- approve or decline paid credits (would change the free-providers constraint);
- supply an `ALERT_WEBHOOK_URL` if alerts should be pushed rather than pulled.

Until a decision changes them, the defaults above stand. `/alerts` raises a
`capacity_pause` warning after a hold lasts an hour, and the runbook's §B
remains the triage path. Backlog R-5 in `docs/ARENA_BACKLOG.md` tracks the
remaining capacity decision.

This is intentionally a written decision, not a code switch: the system cannot
decide to expand its own credential surface.
