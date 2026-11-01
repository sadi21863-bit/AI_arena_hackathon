# Quota posture — 2026-10-31

Status: **operating decision, effective 2026-10-31.** The second-account
question is explicitly reserved for the owner; the default below is what the
system runs until that decision changes.

## Decision

The Arena runs on **one OpenRouter account** (`OPEN_ROUTER_API_KEY_1/2` are a
rate-limit spread inside that account, not a second cap). A second independent
account is **not** added as an automatic mitigation. It changes the credential
surface, the pin/failover matrix, and the operator's key-rotation story, so it
requires an explicit owner decision recorded here.

When the free-tier probe reports the daily budget is gone, the product **holds
dispatches** rather than improvising:

- the build turn is deferred to the next UTC day;
- no blind retries, key rotation, paid fallback, or second account;
- the event may finish the cycle with fewer turns, or with no winner if no team
  produced a buildable outcome — that is a degraded but honest result;
- the hold is visible on `/headroom`, `/alerts` and in the event's
  `paused_capacity` status, not silent.

This is a deliberate acceptance of a lower output ceiling in exchange for a
small, auditable credential surface. It is not a claim that the ceiling is
adequate.

## Revisit triggers

The owner should revisit the single-account decision when any of these is true:

1. Two consecutive cycles lose at least one scheduled build turn to quota
   exhaustion, even though the probe held dispatches correctly.
2. A cycle cannot fit its build window at all and ends with no eligible team.
3. A dead model forces a fallback that consumes the cap faster than the
   primary (measure from the workflow's quota probe, not from token counts).
4. The Arena is expected to run unattended for more than one cycle without an
   operator available to decide a hold.

## How the triggers are monitored (2026-11-01)

`GET /headroom.quota_posture` reports `quota_hold` alerts in the last 14 days:
hold count, distinct events, distinct UTC days, the last hold time, and whether
the revisit proxy is due. The scheduled tick raises one `quota_posture_review`
alert (deduped for 7 days) when **two distinct events** or **three distinct UTC
days** have a hold in that window.

This is deliberately a proxy, not proof of trigger #1. A hold means the probe
refused a dispatch; it does not prove a scheduled turn was lost. The alert says
"review the single-account decision", not "the trigger fired". It does not
provision a second account, rotate keys, add paid credit, or change the hold.
Those remain owner decisions, and the alert is a prompt to revisit this document
with the recorded counts in hand.

## Options if the trigger fires

| option | what it buys | cost / risk |
|---|---|---|
| Second independent OpenRouter account | roughly doubles the daily request ceiling | one more credential to store, rotate and leak-check; two accounts to monitor; still a free tier that can change |
| Paid OpenRouter credits | removes the daily free-tier cap | violates the project's free-providers constraint unless the owner explicitly changes that constraint |
| Reduce turns per team per day | preserves a longer build window inside one cap | fewer iterations, lower build quality; already the default shape (2/day ceiling, often 1 substantive turn) |
| Accept the degraded cycle | no new credential or spend | some cycles produce no winner; must stay visible in the archive |

## Owner action

Approve or decline the second-account option explicitly. Until then:

- no second account is provisioned;
- `/alerts` raises a `capacity_pause` warning after a hold lasts an hour;
- the runbook's §B remains the triage path, and backlog R-5 in
  `docs/ARENA_BACKLOG.md` remains the tracking item.

This is intentionally a written decision, not a code switch: the system cannot
decide to expand its own credential surface.
