# SplitSentinel — Evaluation results

Eval set: `agent/evals/eval-set.json` (19 labelled cases). Seed data: `data/seed/` (78 PRs).
Model: `anthropic.claude-sonnet-4-6`, temperature 0. Prompt version: v1 (`agent/system-prompt.md`).

## 1. Rule layer (offline, `node agent/evals/run-rule-evals.js`)

Checks each case's rule route (release vs. agent), grouping and tier, with no tenant cost.

| Case | Scenario | Score | Route | Patterns | Result |
|---|---|---|---|---|---|
| T1 | CLEAN | 0 | RELEASE | — | PASS |
| T2 | PRIYA_LAPTOPS | 80 | AGENT_HUMAN_REQUIRED | P1, TIER, P2, P6, P3 | PASS |
| T3 | APOLLO_KIT | 30 | AGENT | TIER, PROJ | PASS |
| T4 | STATIONERY | 15 | RELEASE | P1, P3 (−20 recurring) | PASS |
| T5 | BLANKET_CALLOFFS | 25 | RELEASE | P1, TIER, P3 (−30 blanket PO) | PASS |
| T6 | MKT_COLLUSION | 55 | AGENT | P5, TIER, P6, P3 | PASS |
| T7 | SEPARATE_PROJECTS | 35 | AGENT | P1, P6 | PASS |
| T15 | EMERGENCY | 45 | AGENT | P1, TIER, P6 (−10 emergency) | PASS |
| T16 | HABITUAL | 45 | AGENT | TIER, P2, P7 | PASS |

**9 / 9 pass.** 3 of 9 seed anchors (33%) are settled by rules alone and never call the agent.

## 2. End-to-end cloud runs (`uip maestro flow debug`)

| Case | Anchor | Expected | Agent verdict (confidence) | Path | Human | Final | Result |
|---|---|---|---|---|---|---|---|
| T1 | PR-2081 | Released, no agent | NOT_RUN | RULES_RELEASE | — | Released | PASS |
| T7 | PR-2052 | NOT_SPLIT / SEPARATE_PROJECT → Released | NOT_SPLIT / SEPARATE_PROJECT (0.82) | AGENT_RELEASE | — | Released | PASS |
| T2 | PR-2003 | SPLIT → T2 review | SPLIT (0.97), tier T2, PR-2001..2003 | APPROVER_REVIEW | Consolidate | 3 PRs Consolidated | PASS |
| T3 | PR-2013 | SPLIT/LIKELY_SPLIT → review (rules alone: 30) | SPLIT (0.95), related-items (policy §3.3) | APPROVER_REVIEW | Consolidate | 3 PRs Consolidated | PASS |
| T14 | PR-2003 (again) | Skipped | — | SKIPPED_DUPLICATE | — | Skipped | PASS |

**5 / 5 pass.** In every agent run the post-validation step needed **no corrections**: PR ids, combined amount and tier all matched the rule engine.

Evidence written to Data Fabric for each run: one `SplitCase` row (`SC-<prId>`) with rule score, signals, agent verdict and reasoning, human decision and a `runLog`; PR `status` and `splitCaseId` updated.

## 3. Metrics so far

| Metric | Value | Basis |
|---|---|---|
| Split recall (SPLIT + LIKELY_SPLIT on true splits) | 2 / 2 | T2, T3 |
| Correct clears (NOT_SPLIT with the right exception) | 1 / 1 | T7 |
| False positives on clean PRs | 0 / 1 | T1 |
| Agent output corrections needed | 0 / 3 | T2, T3, T7 |
| Share of seed anchors resolved without the agent | 33% | rule layer |

## 4. Still to run

| Case | What it proves |
|---|---|
| T4, T5 | Recurring and blanket PO releases in the cloud (rules-only, cheap) |
| T6, T16 | Collusion and habitual cases through the agent |
| T15 | Emergency exception cleared by the agent |
| T8, T9, T17–T19 | Requester justification loop (needs a case where the agent picks ASK_REQUESTER) |
| T10–T13 | Simulated failures and guardrail (Flow eval simulations) |
| Before/after | A tuning round on the prompt or weights, re-run on the same set |
