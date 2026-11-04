# Build log — SplitSentinel with Claude Code

How SplitSentinel was built with Claude Code (Claude Opus 5.5) using the UiPath skills (`uipath-platform`, `uipath-maestro-flow`). One row per meaningful iteration: what was asked, what Claude Code produced, and what changed as a result.

| # | Date | Goal | What Claude Code did | Result / what changed |
|---|---|---|---|---|
| 1 | 2026-11-04 | Pick the problem | Brainstormed procurement ideas, analysed spend splitting (patterns P1–P8, legitimate exceptions, data model, flow, risks) | Locked SplitSentinel; wrote the build plan |
| 2 | 2026-11-04 | Verify the tenant | Used `uip` to read licences, Data Fabric, Integration Service connections, Action Center, agent models | Found Python missing (needed by `uip context-grounding`); installed Python 3.12 + `uipath` SDK in `.venv` |
| 3 | 2026-11-04 | Prove Flow + agent run | Built a two-step smoke-test Flow (`flow init --automate`), ran `check → compile → validate → debug` | Completed in the cloud; inline agent returned a correct split verdict |
| 4 | 2026-11-04 | Rule engine | Wrote `rules/score.js` as a pure ES2019 function and 15 `node:test` cases, including the boundaries (₹1,00,000; 84.9% vs 85%; 72 h ± 1 min; 30-day lookback) | 15/15 passed on the first run |
| 5 | 2026-11-04 | Make the scenarios hold | Designed 9 planted scenarios. The first draft of "Priya's laptops" (3 × ₹1.45L) never crossed a tier, so splitting gained nothing; the Apollo case scored 20 and never reached the agent | Priya → 3 × ₹95k (each T1, combined T2); added a `PROJ` (+10) signal so the Apollo case lands at 30 and is judged by the agent |
| 6 | 2026-11-04 | Seed data that can't drift | `data/generate-seed.js` scores every planted scenario with the real rule engine and fails if a route changes; background PRs that would touch a scenario group are dropped | 78 PRs; all 9 scenarios on their expected route; re-checked against the full table |
| 7 | 2026-11-04 | Data Fabric schema | Followed the skill's gates: schema preview + scope question before any create; avoided UI-broken types (`DECIMAL` for integers, `DATETIME_WITH_TZ`) | 6 tenant entities created after approval; 126 records imported with 0 errors |
| 8 | 2026-11-04 | Flow v1 | Wrote the Flow in the TypeScript builder SDK, inlining `rules/score.js` and the policy at compile time | `check` found 11 errors: bare step reads, Data Fabric reads with no error port, computed human-task field values |
| 9 | 2026-11-04 | Flow v2 | Read step outputs via `<step>.output`; moved failure handling to a rule-engine `UNVERIFIED` route; built form text in script steps | 0 errors; `validate` Valid but 20 warnings |
| 10 | 2026-11-04 | Zero warnings | Stripped the Node `module.exports` footer when inlining; declared the rules step's output fields | `check` 0/0, `validate` Valid with no warnings |
| 11 | 2026-11-04 | First cloud run (T1) | `flow debug` on PR-2081 | Faulted at `writeCase`: `decidedAt` was an empty string → always stamp the closing time. Re-run: Completed, Released by rules |
| 12 | 2026-11-04 | Agent path (T7) | `flow debug` on PR-2052 | Agent: NOT_SPLIT / SEPARATE_PROJECT (0.82), released by the gateway; no corrections needed |
| 13 | 2026-11-04 | Human path (T2) | `flow debug` on PR-2003; read the Action Center task data; completed it with `uip tasks complete --action Consolidate` | See `docs/evaluation-results.md` |

## Things that surprised us

- Maestro Flow human tasks have no timeout/SLA option (that exists in Maestro Case), so SLA escalation moved out of the Flow.
- Data Fabric read nodes have no error port, so "retry ×3" in the original plan became "fail the run, never release".
- The `uip` CLI PascalCases record keys in its output (`prId` → `PrId`), while JMESPath filters must use the PascalCase name.
- PowerShell 5.1 splits JSON arguments to `uip` (a `.ps1` wrapper) at spaces; Bash passes them intact.
