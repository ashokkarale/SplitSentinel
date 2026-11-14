# SplitSentinel

**An agent that catches split purchases before they reach a PO.**

SplitSentinel is a UiPath **Maestro Automate** Flow. Each time a purchase requisition (PR) is submitted, it checks whether that PR and recent related PRs are really one purchase split to stay under an approval threshold, a quote requirement or a competitive-bidding requirement. If so, it sends the case to the approver for the **combined** amount before any PO is issued.

```
PR submitted ─► load context (Data Fabric) ─► rule engine (score 0-100)
                                                │
                  score < 30 ◄──────────────────┤
                  release                       ▼
                                   inline agent (Claude Sonnet 4.6)
                                   + output validation, 1 retry
                                                │
                                   gateway + guardrail
                     ┌─────────────────┬────────┴─────────────┐
                     ▼                 ▼                      ▼
                  release      requester explains     approver review
                               → agent re-judges      (Action Center, combined tier)
                                                │
                     update PR status ─► SplitCase audit record
```

The agent can never clear a high-risk case on its own. Any failure ends in a hold or a human decision, never an auto-approval.

## What's in the repo

| Path | What it is |
|---|---|
| `SplitSentinel/` | UiPath solution. The Flow source is `SplitSentinel/SplitSentinel/.flow-sdk/SplitSentinel.flow.ts` |
| `rules/score.js` | Deterministic rule engine (also inlined into the Flow at compile time) + `score.test.js` |
| `agent/` | System prompt, output schema, labelled eval set, offline rule eval runner |
| `data/` | Entity schema (`entities.md`, `entities.schema.json`), deterministic seed generator, seed CSV/JSON, procurement policy |
| `templates/notifications.md` | Notification text |
| `docs/` | Architecture diagram, build log, evaluation results |
| `AGENTS.md` | Technical guide for coding agents working on the repo |

## Setup

Requires a UiPath Automation Cloud tenant with Maestro, Agents, Data Fabric and Action Center, plus Node.js 20+.

1. Install the CLI and Flow SDK:
   ```bash
   npm install -g @uipath/cli @uipath/maestro-builder-sdk
   ```
2. Sign in (interactive, run it yourself):
   ```bash
   uip login
   ```
3. Run the unit tests and regenerate the seed data:
   ```bash
   node --test rules/
   node data/generate-seed.js
   ```
4. Create the six Data Fabric entities from `data/entities.schema.json` (one `uip df entities create <Name> -f <file>` per entity; see `data/entities.md`), then import the seed CSVs with `uip df records import <entity-id> --file data/seed/<file>.csv`.
5. Build and validate the Flow (from `SplitSentinel/SplitSentinel/`, then `SplitSentinel/`):
   ```bash
   uip maestro flow check .flow-sdk/SplitSentinel.flow.ts --source
   uip maestro flow compile .flow-sdk/SplitSentinel.flow.ts -o SplitSentinel.flow
   uip maestro flow validate SplitSentinel/SplitSentinel.flow
   ```
6. Run one case in the cloud (input is the PR id; `whatIf: true` re-checks without changing anything):
   ```bash
   uip maestro flow debug SplitSentinel --inputs '{"requisitionId":"PR-2003","whatIf":false}'
   ```
   Once deployed, the Flow also starts on its own when a `PurchaseRequisition` record is created (Data Fabric `record-created` event).

## Scenarios in the seed data

| Anchor PR | Scenario | Expected |
|---|---|---|
| PR-2081 | Single clean PR | Released by rules, no agent call |
| PR-2003 | 3 × ₹95k laptops, same requester and vendor, 3 days | SPLIT → Department Head review |
| PR-2013 | Laptops, chargers, docks for one project from 3 vendors | Agent groups them (rules alone score 30) |
| PR-2025 | Monthly stationery, recurring vendor | Released |
| PR-2034 | Call-offs against a valid blanket PO | Released |
| PR-2042 | Two marketing requesters, same vendor, same day | LIKELY_SPLIT → CFO + RFQ |
| PR-2052 | Same vendor, genuinely separate projects | Agent clears it (SEPARATE_PROJECT) |
| PR-2065 | Requester habitually at 92–99% of limit | LIKELY_SPLIT |
| PR-2072 | Two emergency generator repair PRs | Agent clears it (EMERGENCY) |

Evaluation results: [`docs/evaluation-results.md`](docs/evaluation-results.md).

## Known limits

- **No SLA timers in the Flow.** Maestro Flow human tasks have no timeout option, so the 24 h / 48 h escalation is not modelled inside the Flow. Configure it in Action Center, or in a Maestro Case wrapper.
- **Data Fabric reads have no error port.** A failed read faults the run (nothing is released). Empty reference data is held as `Unverified`.
- **Notifications are Gmail drafts.** The notify step saves a draft (`SaveAsDraft: true`) instead of sending; switch it once real recipient addresses are in place.
- **Demo-scale reads.** The Flow reads up to 1,000 PRs and filters them in the rule engine; a production version would filter by date on the server.
