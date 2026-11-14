# SplitSentinel — Build Plan

> **SplitSentinel: an agent that catches split purchases before they reach a PO.**
> Entry for *Agents at Work: The Maestro Automate Challenge* (UiPath Community)

| Item | Value |
|---|---|
| Plan date | 2026-11-04 |
| Submission deadline | **2026-11-30** |
| Jury evaluation starts | 2026-12-01 |
| Winners announced | 2026-12-15 |
| Project type | Maestro Automate (Flow) — short-running, **not** BPMN / Maestro Orchestrate |
| Build environment | VS Code + UiPath Maestro extension (primary), Studio Web (fallback) |
| Coding agent | Claude Code |
| Forum tag | `maestro-automate-challenge` |

---

## Table of contents

1. [Problem statement](#1-problem-statement)
2. [Goals, scope and non-goals](#2-goals-scope-and-non-goals)
3. [Judging criteria mapping](#3-judging-criteria-mapping)
4. [Everything we need (accounts, tools, assets)](#4-everything-we-need)
5. [Architecture](#5-architecture)
6. [Repository / folder structure](#6-repository--folder-structure)
7. [Data model (Data Service entities)](#7-data-model-data-service-entities)
8. [Reference data: approval matrix and policy](#8-reference-data-approval-matrix-and-policy)
9. [Synthetic seed data](#9-synthetic-seed-data)
10. [Rule engine specification](#10-rule-engine-specification)
11. [Agent specification](#11-agent-specification)
12. [Flow specification (node by node)](#12-flow-specification-node-by-node)
13. [Human-in-the-loop design](#13-human-in-the-loop-design)
14. [Error handling and resilience](#14-error-handling-and-resilience)
15. [Testing and evaluations](#15-testing-and-evaluations)
16. [Claude Code collaboration log](#16-claude-code-collaboration-log)
17. [Timeline and task breakdown](#17-timeline-and-task-breakdown)
18. [Demo plan](#18-demo-plan)
19. [Submission checklist](#19-submission-checklist)
20. [Risks and mitigations](#20-risks-and-mitigations)
21. [Open questions to verify early](#21-open-questions-to-verify-early)
22. [Roadmap (post-challenge)](#22-roadmap-post-challenge)

---

## 1. Problem statement

Organisations enforce an **approval matrix**: purchases above certain amounts need higher approvers, multiple quotes, or a formal RFQ. **Spend splitting** is breaking one purchase into several smaller requisitions or POs, each below a threshold, to dodge the higher approval or the competitive-bidding requirement.

- **Why it happens:** convenience (avoiding slow approvals), favouritism (steering to a preferred vendor), or fraud (kickbacks, collusion).
- **How it is caught today:** usually months later by internal audit running after-the-fact analytics on PO data. By then the money is spent.
- **Gap:** ERP approval workflows evaluate each requisition **in isolation**. They do not look at the pattern across requisitions, and rules alone cannot tell that "laptops", "chargers" and "docking stations" for the same project are one need.

**SplitSentinel** checks every new purchase requisition (PR) at the moment it is created, groups it with related recent PRs, scores it with deterministic rules, asks an AI agent to judge whether the group is really one need, and routes suspicious cases to the **correct** approver (for the combined amount) through Action Center — before a PO is issued.

---

## 2. Goals, scope and non-goals

### Goals (must ship by Nov 30)
- [ ] Real-time check on PR creation (event trigger).
- [ ] Deterministic rule scoring for patterns P1, P2, P3, P5, P6, P7.
- [ ] Agent judgement for semantic grouping (P4) and legitimate-exception recognition.
- [ ] Guardrail: agent can never clear a high-risk case on its own.
- [ ] Requester justification loop (optional step for medium confidence).
- [ ] Action Center task to the approver for the **combined** amount.
- [ ] SLA escalation on the human task.
- [ ] Retry / fail-closed handling for every external call.
- [ ] Full audit trail in a `SplitCase` entity.
- [ ] 12+ evaluation scenarios with measured precision / recall.
- [ ] Recorded demo + complete forum submission.

### Stretch goals (only if ahead of schedule)
- [ ] Nightly scheduled sweep for vendor-side invoice splitting (P8).
- [ ] Repeat-offender alert to Internal Audit (3+ confirmed splits / 90 days).
- [ ] Simple dashboard (Data Service view or a small app) of open cases.

### Non-goals
- Integration with a real production ERP (we simulate the ERP with Data Service; the design shows where Integration Service connectors plug in).
- BPMN / long-running orchestration (out of challenge scope).
- Automatic rejection without a human — SplitSentinel recommends, humans decide.

---

## 3. Judging criteria mapping

| Criterion | Weight | How SplitSentinel scores |
|---|---|---|
| Innovation & idea | 30% | Prevention at PR time (not post-hoc audit); agent catches semantic splits rules miss (P4); collusion detection (P5); guardrail where the agent cannot override high rule risk; requester-justification loop re-evaluated by the agent. |
| Build quality & completeness | 40% | Multiple actor types (event trigger, script/rules, agent, Data Service, Action Center, notifications); retries + fail-closed; SLA escalation; output validation of agent; 12+ eval scenarios with metrics; documented iteration with Claude Code. |
| Real-world relevance | 30% | Common audit finding for any company with an approval matrix; works with any ERP via Integration Service; clear ROI (recovered competitive bidding, control effectiveness, audit trail). |

**"Strong entry" checklist from the challenge post:**
- [ ] Built collaboratively with a coding agent, several iteration rounds → §16
- [ ] More than one kind of actor → §5
- [ ] Tested with debugging and evaluations across scenarios → §15
- [ ] Handles failures by retrying or escalating → §14
- [ ] Realistic trigger → §12 (PR-created event)

---

## 4. Everything we need

### 4.1 Accounts and licences

> Checked 2026-11-04 with the `uip` CLI (v1.205.0), logged in as the owner account.
> **Org:** `<your-org>` · **Tenant:** `DefaultTenant` (`<tenant-id>`) · **Plan:** `COMMUNITY`

| # | Item | Purpose | Status | Evidence |
|---|---|---|---|---|
| A1 | UiPath Automation Cloud account (Community Edition) | Maestro, Data Service, Action Center, Agents | ✅ Done | `uip login status` → logged in; `uip or licenses info` → `SubscriptionPlan: COMMUNITY`, not expired |
| A2 | Maestro Automate Flow in the tenant | Build and run the Flow | ✅ Done | Smoke-test Flow `SmokeTest` (created with `flow init --automate`, so it's a Maestro Automate project) passed `check`, `compile` and `validate` (Status: Valid), then ran in the cloud with `uip maestro flow debug` → **Completed**, no failed nodes (instance `<debug-instance-id>`) |
| A3 | Agents (LLM access) | Agent node | ✅ Works · units still to confirm | The same run's inline agent (`anthropic.claude-haiku-4-5-20251001-v1:0`) returned a correct verdict ("…appear to be one purchase split to circumvent the 1,50,000 INR approval limit"). 20+ models are available (`uip agent model list`), including Claude Haiku 4.5, Sonnet 4.6/5 and Opus 4.8. **Unit consumption after the run: RU/AGU/PLTU all 0.** Debug runs may not be billed, or the report lags. Recheck on Nov 5 |
| A4 | Data Service (Data Fabric) | Entities + record-created trigger | ✅ Done | Data Service Units: 1 allocated; entity `InvoiceRecord` already exists; IS connection *UiPath Data Fabric* = Enabled (default) |
| A5 | Action Center | Human tasks | ✅ Done | `uip tasks list` works; a `QuickFormTask` created by a workflow was completed on 2026-07-24 |
| A6 | Integration Service connector for notifications | Notifications, requester justification | ✅ Done | *Gmail Connection* (`uipath-google-gmail`) = Enabled (default). Use Gmail for all emails |
| A7 | GitHub account (public repo) | Share solution files | ✅ Done | GitHub CLI 2.103.3 installed and signed in. Public repo [ashokkarale/SplitSentinel](https://github.com/ashokkarale/SplitSentinel) created; local repo `main` pushed. Commits use the GitHub noreply address. `.gitignore` excludes `.venv/`, `SmokeTest/` and secrets |
| A8 | UiPath Forum account | Submission | ✅ Done | Checked by hand 2026-11-04: signed in at forum.uipath.com and confirmed posting access to the challenge category |

**Other findings**
- **Unused licences:** 1 Unattended Robot and 1 Test Automation Unattended Robot are allocated. SplitSentinel doesn't need them.
- **Python 3.12.10 installed (2026-11-04)** via winget (user scope). The project virtual environment is `E:\Maestro Challenge\.venv`, with the `uipath` SDK 2.15.0 installed. `uip context-grounding setup` succeeded, and `uip context-grounding list` works (existing index: `SupportGroups` in `Shared`).
  - Activate the virtual environment before any `uip context-grounding` command: `.\.venv\Scripts\Activate.ps1`
  - Policy document options: put it inline in the agent prompt (simplest), or upload it to a storage bucket and index it with Context Grounding (shows one more platform feature to the judges).
- **Robot Units expire Nov 30** (300 units for this month). Keep the evaluation set small (about 25 cases), and let low-risk PRs skip the agent.
- **The CLI login refreshes itself.** The token passed its 18:03 UTC expiry and was renewed automatically. Run `uip login` only if `uip login status` says you're logged out.
- **Maestro Flow builder SDK** `@uipath/maestro-builder-sdk` 6.74.2 installed globally (npm). Flows are written in TypeScript (`.flow-sdk/<Name>.flow.ts`) and compiled to `.flow`.
- **Smoke-test solution** lives in `E:\Maestro Challenge\SmokeTest` and isn't tracked by Git. Delete it once the real SplitSentinel solution is running.

**Remaining actions**
- [x] Run a test Flow (closes A2). Done 2026-11-04: Completed
- [x] Run one agent call (A3). Done 2026-11-04: agent answered correctly
- [ ] Nov 5: recheck units used: `uip platform licenses consumables get --mode daily --tenant DefaultTenant --unit RU --start-date 2026-11-01 --end-date 2026-11-30` (repeat with `--unit AGU` and `--unit PLTU`)
- [x] Create the public GitHub repo `SplitSentinel` and push the first commit (closes A7). Done 2026-11-04
- [x] Sign in at forum.uipath.com and confirm you can post in the challenge category (closes A8). Done 2026-11-04, checked by hand

### 4.2 Tools on the PC
| # | Tool | Purpose |
|---|---|---|
| T1 | VS Code (latest) | Main IDE ✅ |
| T2 | UiPath Maestro extension (VS Code Marketplace / Open VSX) | Author, run, debug, publish Flows ✅ `uipath.uipath-maestro` |
| T3 | `uip` CLI | Scripting, packaging, Data Fabric, tasks ✅ v1.205.0, logged in |
| T4 | Claude Code | Coding agent ✅ (VS Code extension installed too) |
| T5 | Git | Version control, commit history as iteration evidence ✅ 2.56 (`gh` not installed) |
| T6 | Node.js (Python optional) | Seed-data generator and local rule-engine unit tests ✅ Node 26 · Python 3.12.10 (`.venv` with `uipath` SDK) |
| T7 | Screen recorder (OBS Studio or Xbox Game Bar) | Demo video |
| T8 | Draw.io / Excalidraw / Mermaid | Architecture diagram |

### 4.3 Assets we must create

> Status as of 2026-11-14.

| # | Asset | Section | Status | Where / evidence |
|---|---|---|---|---|
| D1 | Data Service entities (6) | §7 | ✅ Done | Tenant-level: Employee, Vendor, BlanketPO, ApprovalMatrix, PurchaseRequisition, SplitCase. Schema in `data/entities.schema.json` / `data/entities.md` (enumerations are `STRING`, not choice sets) |
| D2 | Approval matrix records | §8 | ✅ Done | 4 tiers imported (T1–T4) |
| D3 | Procurement policy document (agent grounding) | §8 | ✅ Done | `data/policy/procurement-policy.md`, inlined into the agent's system prompt at compile time |
| D4 | Seed data: ~80 PRs, ~15 vendors, ~20 employees, 3 blanket POs | §9 | ✅ Done | `data/generate-seed.js` → 78 PRs, 16 vendors, 25 employees, 3 blanket POs; all imported, 0 errors; 9 planted scenarios self-checked |
| D5 | Rule-engine script + unit tests | §10 | ✅ Done | `rules/score.js` + `rules/score.test.js` (15/15 pass) |
| D6 | Agent: system prompt, input/output schema, evaluation set | §11 | ✅ Done | `agent/system-prompt.md`, `agent/output-schema.json`, `agent/evals/eval-set.json` (19 cases), `agent/evals/run-rule-evals.js` |
| D7 | Maestro Flow (main) | §12 | ✅ Built | 52 nodes, two entry points (manual + Data Fabric `record-created`), what-if mode, Gmail drafts. `check` 0/0, `validate` Valid with no warnings. **Not yet proven live:** the event trigger (needs a deployed solution) and the Gmail draft step (creates drafts in your mailbox) |
| D8 | Action Center task form(s) | §13 | ✅ Done | Approver review quick form (4 outcomes + comment), proven live: task created, completed, Flow resumed |
| D9 | Requester justification form / email template | §13 | ✅ Done | Ran live on T16: requester task → justification → agent re-judged → approver review |
| D10 | Notification templates (approved, held, consolidated, escalated) | §12 | ✅ Done | `templates/notifications.md` (sending not wired yet, see D7) |
| D11 | Evaluation results sheet (before/after tuning) | §15 | ✅ Done | `docs/evaluation-results.md`: rule layer 9/9; live runs 10/10; guardrail + failure 2/2 (Flow eval with simulated agent); tuning v1 → v2 → v3 with before/after; T9, T10, T13, T17–T19 not run (reasons documented) |
| D12 | Architecture diagram | §5 | ✅ Done | `docs/architecture.mmd` (Mermaid) |
| D13 | Demo video (3–5 min) | §18 | ☐ You | All Flow pieces are in; record using the demo plan in §18 |
| D14 | README + "How I built it with Claude Code" write-up | §16, §19 | ✅ Done | `README.md`, `docs/claude-code-log.md` |

**Design changes found while building** (also in `AGENTS.md`):
- Maestro Flow human tasks have no timeout or SLA, so the 24 h / 48 h escalations move to Action Center settings.
- Data Fabric read nodes have no error port, so a failed read faults the run (still fail-closed) instead of retrying ×3.
- Priya's scenario changed to 3 × ₹95k (each T1, combined T2), so the split actually avoids a tier.

---

## 5. Architecture

```
                         ┌──────────────────────────────┐
  Requester ── creates ─►│  PurchaseRequisition entity  │  (simulated ERP; in prod:
                         │  (Data Service)              │   SAP / Oracle / Coupa / Ariba
                         └──────────────┬───────────────┘   via Integration Service)
                                        │ record-created event
                                        ▼
┌───────────────────────────── Maestro Automate Flow: SplitSentinel ─────────────────────────────┐
│                                                                                                 │
│  [1 Normalize] → [2 Fetch context ‖] → [3 Rule engine] → (score < 30?) ── yes ─► [Release+log] │
│                     • ApprovalMatrix                          │ no                              │
│                     • Recent PRs (30d)                        ▼                                 │
│                     • Employee / Vendor             [4 Agent judgement]                         │
│                                                               ▼                                 │
│                                                    [5 Validate agent output]                    │
│                                                               ▼                                 │
│                                                    [6 Decision gateway + guardrail]             │
│                                     ┌─────────────────────────┼──────────────────────┐          │
│                                     ▼                         ▼                      ▼          │
│                             [Release + log]     [7 Requester justification]   [8 Action Center] │
│                                                       └──► re-run agent ──────────►  task       │
│                                                                                      ▼          │
│                                                                            [9 Apply decision]   │
│                                                                    • update PR status           │
│                                                                    • write SplitCase            │
│                                                                    • notify requester/manager   │
│                                                                    • repeat-offender check      │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**Actor types used:** event trigger · deterministic script · LLM agent · Data Service (read/write) · Action Center (human) · Integration Service connector (email/Teams/Slack) · timers (SLA).

---

## 6. Repository / folder structure

```
SplitSentinel/
├── README.md                     # overview, setup, how to run, demo link
├── SplitSentinel_Build_Plan.md   # this file
├── docs/
│   ├── architecture.png
│   ├── architecture.mmd          # Mermaid source
│   ├── claude-code-log.md        # iteration log (prompts, what changed, why)
│   └── evaluation-results.md     # metrics before/after tuning
├── flow/                         # Maestro Flow project (exported from VS Code / Studio Web)
├── agent/
│   ├── system-prompt.md
│   ├── input-schema.json
│   ├── output-schema.json
│   └── evals/
│       └── eval-set.json         # labelled scenarios T1..T14
├── rules/
│   ├── score.js                  # rule engine (same code pasted into the Flow script node)
│   └── score.test.js
├── data/
│   ├── entities.md               # entity definitions
│   ├── generate-seed.js          # synthetic data generator
│   ├── seed/
│   │   ├── employees.csv
│   │   ├── vendors.csv
│   │   ├── approval_matrix.csv
│   │   ├── blanket_pos.csv
│   │   └── purchase_requisitions.csv
│   └── policy/
│       └── procurement-policy.md # agent grounding document
├── forms/
│   ├── action-center-review.json
│   └── requester-justification.json
└── templates/
    └── notifications.md
```

---

## 7. Data model (Data Service entities)

### 7.1 `Employee`
| Field | Type | Notes |
|---|---|---|
| employeeId | Text (PK) | E001… |
| name | Text | |
| email | Text | demo mailbox aliases |
| managerId | Text | → Employee |
| costCenter | Text | CC-IT, CC-OPS, CC-MKT… |
| approvalLimit | Decimal | own approval authority (INR) |
| role | Choice | Requester / LineManager / DeptHead / CFO / Audit |

### 7.2 `Vendor`
| Field | Type | Notes |
|---|---|---|
| vendorId | Text (PK) | V001… |
| name | Text | |
| category | Choice | IT Hardware, Stationery, Facilities, Marketing, Services… |
| isRecurring | Boolean | recurring-spend vendor (e.g. stationery, cleaning) |
| contactEmail | Text | |

### 7.3 `BlanketPO`
| Field | Type | Notes |
|---|---|---|
| blanketPoId | Text (PK) | BPO-001… |
| vendorId | Text | |
| category | Choice | |
| approvedAmount | Decimal | |
| consumedAmount | Decimal | |
| validFrom / validTo | Date | |
| approvedBy | Text | |

### 7.4 `ApprovalMatrix`
| Field | Type | Notes |
|---|---|---|
| tierId | Text (PK) | T1…T4 |
| minAmount | Decimal | inclusive |
| maxAmount | Decimal | exclusive (null = no cap) |
| approverRole | Choice | |
| quotesRequired | Integer | |
| rfqRequired | Boolean | |

### 7.5 `PurchaseRequisition`
| Field | Type | Notes |
|---|---|---|
| prId | Text (PK) | PR-1001… |
| requesterId | Text | → Employee |
| costCenter | Text | |
| projectCode | Text | nullable |
| vendorId | Text | → Vendor |
| category | Choice | |
| description | Text (long) | free text — key input for semantic grouping |
| quantity | Integer | |
| unitPrice | Decimal | |
| amount | Decimal | INR |
| currency | Text | default INR |
| deliverySite | Text | |
| blanketPoRef | Text | nullable |
| isEmergency | Boolean | |
| createdAt | DateTime | |
| status | Choice | Draft / Submitted / UnderReview / OnHold / Unverified / Released / Consolidated / Rejected |
| splitCaseId | Text | nullable → SplitCase |

### 7.6 `SplitCase` (audit trail)
| Field | Type | Notes |
|---|---|---|
| caseId | Text (PK) | SC-0001… |
| anchorPrId | Text | PR that triggered the run |
| relatedPrIds | Text | comma-separated / JSON |
| combinedAmount | Decimal | |
| ruleScore | Integer | 0–100 |
| rulePatterns | Text | e.g. "P1,P2,P6" |
| agentVerdict | Choice | SPLIT / LIKELY_SPLIT / NOT_SPLIT / NOT_RUN / FAILED |
| agentConfidence | Decimal | |
| agentLegitException | Choice | NONE / RECURRING / BLANKET_PO / SEPARATE_PROJECT / EMERGENCY / STAGGERED_DELIVERY |
| agentReasoning | Text (long) | |
| requiredApprovalTier | Text | |
| requesterJustification | Text (long) | nullable |
| humanDecision | Choice | CONSOLIDATE / APPROVE_SEPARATE / REJECT / FALSE_POSITIVE / ESCALATED |
| humanComment | Text (long) | |
| decidedBy | Text | |
| decidedAt | DateTime | |
| finalOutcome | Choice | Released / Consolidated / Rejected / Unverified |
| runLog | Text (long) | step-by-step trace for audit |

---

## 8. Reference data: approval matrix and policy

### 8.1 Approval matrix (seed)
| Tier | Min (INR) | Max (INR) | Approver | Quotes | RFQ |
|---|---|---|---|---|---|
| T1 | 0 | 1,00,000 | Line Manager | 1 | No |
| T2 | 1,00,000 | 5,00,000 | Department Head | 3 | No |
| T3 | 5,00,000 | 25,00,000 | CFO | 3 | Yes |
| T4 | 25,00,000 | — | CFO + Procurement Committee | 3 | Yes |

### 8.2 Procurement policy document (`data/policy/procurement-policy.md`)
Short (1–2 pages), written for the agent to ground on. Must include:
1. **Definition of splitting** — "dividing a single requirement into multiple requisitions or orders to avoid an approval tier or competitive-bidding requirement is prohibited."
2. **What counts as a single requirement** — same project/need, same delivery window, items that are components/accessories of one another, same vendor for the same need.
3. **Legitimate exceptions** — recurring consumables from designated recurring vendors; call-offs against an approved blanket PO; separate projects or cost centres with distinct business purpose; documented emergencies; vendor-agreed staggered deliveries approved at the combined level.
4. **Lookback window** — 30 days.
5. **Consequence** — combined requirement is routed to the approver for the combined amount.

---

## 9. Synthetic seed data

Generated by `data/generate-seed.js` (written with Claude Code), deterministic seed so results are reproducible.

| Entity | Count | Notes |
|---|---|---|
| Employee | ~20 | 4 cost centres, mix of roles, limits ₹50k–₹1.5L for requesters |
| Vendor | ~15 | 4 recurring vendors (stationery, cleaning, pantry, courier) |
| BlanketPO | 3 | one IT, one facilities, one marketing |
| ApprovalMatrix | 4 | §8.1 |
| PurchaseRequisition | ~80 | ~55 clean background PRs over 60 days + planted scenarios below |

**Planted scenarios (must exist in seed):**
| Scenario | PRs | Pattern |
|---|---|---|
| Priya laptops | 3 × ₹1.45L, same vendor, 3 days | P1, P2, P6 |
| Project Apollo IT kit | laptops ₹95k, chargers ₹40k, docks ₹60k, same project, 6 days | P4 |
| Monthly stationery | 6 × ₹30–45k across 6 months | legit RECURRING |
| Blanket call-offs | 4 × ₹80k against BPO-001 | legit BLANKET_PO |
| Marketing collusion | 2 requesters, same CC, same vendor, same day, ₹2.4L each | P5 |
| Two genuine projects | same vendor, different projects, sites, purposes | legit SEPARATE_PROJECT |
| Habitual near-limit | requester with 5 historical PRs at 92–99% of limit | P7 |
| Emergency repair | 2 PRs flagged emergency | legit EMERGENCY |

---

## 10. Rule engine specification

Runs in a **script node** in the Flow. Same code lives in `rules/score.js` with unit tests.

### 10.1 Candidate selection
From PRs in the last **30 days** (status not Rejected/Draft), select those where any of:
- same `vendorId` AND same `requesterId`
- same `vendorId` AND same `costCenter`
- same `projectCode` (non-null)
- same `requesterId` AND same `category`

### 10.2 Scoring (per candidate group anchored on the new PR)
| Signal | Points | Pattern |
|---|---|---|
| Same vendor + same requester | +25 | P1 |
| Same vendor + different requester, same cost centre | +15 | P5 |
| Combined amount crosses a higher tier than the anchor PR alone | +20 | — |
| Each PR within 85–100% of a tier boundary or requester limit | +15 | P2 |
| All PRs submitted within 72 h | +10 | P6 |
| Description similarity ≥ 0.7 (token Jaccard) | +10 | P3 |
| Requester history: ≥3 PRs at 90–100% of limit in 90 days | +10 | P7 |
| Vendor `isRecurring` = true | −20 | exception |
| All PRs reference the same valid blanket PO | −30 | exception |
| `isEmergency` = true on all PRs | −10 | exception |

`score = clamp(sum, 0, 100)`

### 10.3 Output
```json
{
  "score": 70,
  "patterns": ["P1", "P2", "P6"],
  "groupPrIds": ["PR-1041", "PR-1042", "PR-1043"],
  "combinedAmount": 435000,
  "anchorTier": "T2",
  "combinedTier": "T2",
  "crossesTier": false,
  "requesterLimit": 150000,
  "exceedsRequesterLimit": true
}
```

### 10.4 Routing thresholds
| Score | Path |
|---|---|
| 0–29 | Release + log (agent not called — saves cost and latency) |
| 30–59 | Agent judgement; agent may clear with a valid legit exception |
| 60–100 | Agent judgement; **human review mandatory** regardless of agent verdict |

---

## 11. Agent specification

### 11.1 Role
"Procurement controls analyst." Decides whether a group of PRs represents a single requirement split to avoid an approval tier, using only the data provided and the procurement policy.

### 11.2 Inputs
```json
{
  "anchorPr": { "...PurchaseRequisition fields..." },
  "candidatePrs": [ { "...": "..." } ],
  "ruleResult": { "...§10.3..." },
  "approvalMatrix": [ { "...": "..." } ],
  "vendor": { "...": "..." },
  "requester": { "...": "..." },
  "blanketPos": [ { "...": "..." } ],
  "requesterJustification": null
}
```
Policy text supplied via grounding (Context Grounding index) or inline in the prompt.

### 11.3 Output schema (enforced structured output)
```json
{
  "verdict": "SPLIT | LIKELY_SPLIT | NOT_SPLIT",
  "confidence": 0.0,
  "patterns": ["P1", "P4"],
  "relatedPrIds": ["PR-1041"],
  "combinedAmount": 0,
  "requiredApprovalTier": "T1 | T2 | T3 | T4",
  "competitiveBidRequired": true,
  "legitException": "NONE | RECURRING | BLANKET_PO | SEPARATE_PROJECT | EMERGENCY | STAGGERED_DELIVERY",
  "reasoning": "≤ 120 words, cite PR ids and field values only",
  "suggestedAction": "CONSOLIDATE | ASK_REQUESTER | APPROVE"
}
```

### 11.4 System prompt (draft v1 — iterate with Claude Code)
```
You are SplitSentinel, a procurement controls analyst.
Decide whether the anchor purchase requisition and the candidate requisitions
represent ONE business requirement that was split to avoid an approval tier or
a competitive-bidding requirement.

Rules:
- Use ONLY the data provided and the procurement policy. Never invent PRs, amounts or facts.
- relatedPrIds may contain ONLY ids present in the input.
- Treat items as one requirement when they share a project, purpose or delivery
  window, or are components/accessories of each other (e.g. laptops, chargers, docks).
- Recognise legitimate exceptions: recurring vendor consumables, call-offs against a
  valid blanket PO, genuinely separate projects/cost centres/sites, documented
  emergencies, vendor-agreed staggered deliveries approved at combined level.
- If a requester justification is provided, evaluate whether it is specific and
  consistent with the data; vague reasons ("urgent", "always done this way") do not qualify.
- When evidence is mixed, prefer LIKELY_SPLIT with ASK_REQUESTER over NOT_SPLIT.
- Compute requiredApprovalTier from the combined amount and the approval matrix.
- Return ONLY JSON matching the output schema.
```

### 11.5 Post-validation (script node after the agent)
- JSON parses and matches the schema.
- Every id in `relatedPrIds` ∈ input ids (anti-hallucination).
- `combinedAmount` equals the sum of related PR amounts (±1). If not, overwrite with the computed value and log the correction.
- `requiredApprovalTier` matches the matrix lookup for `combinedAmount`. If not, overwrite and log.
- On validation failure: retry the agent once with the validation error appended; second failure → `agentVerdict = FAILED`, route to human with rule evidence only.

---

## 12. Flow specification (node by node)

> Node names are logical; map them to the actual Maestro Flow node types available in the extension (trigger, script, agent, connector/API call, decision, human task, timer). Verify in §21.

| # | Node | Type | Input | Output / behaviour |
|---|---|---|---|---|
| 0 | **On PR submitted** | Trigger (Data Service record created/updated where status = Submitted) | PR record | `prId` |
| 1 | **Load & normalise PR** | Data Service read + script | `prId` | normalised PR (currency → INR, trimmed text, lower-cased description tokens) |
| 2a | **Load approval matrix** | Data Service query | — | tiers |
| 2b | **Load recent PRs (30d)** | Data Service query | vendor, requester, costCentre, projectCode | candidate pool |
| 2c | **Load requester, vendor, blanket POs** | Data Service reads | ids | context |
| — | *Retry policy on 2a–2c* | 3 attempts, backoff 2s/4s/8s | | on final failure → node 9U |
| 3 | **Rule engine** | Script | PR + context | rule result §10.3 |
| 4 | **Low risk?** | Decision | score | `<30` → node 9R; else → 5 |
| 5 | **Agent judgement** | Agent | §11.2 | §11.3 |
| 6 | **Validate agent output** | Script | agent output + input ids | validated verdict or FAILED (with one retry of node 5) |
| 7 | **Gateway + guardrail** | Decision | verdict, confidence, score | see table below |
| 8a | **Requester justification** | Human task / email-form via connector | case summary | justification text (timeout 24h → treat as "no justification") |
| 8b | **Agent re-evaluation** | Agent (same as 5, with justification) | input + justification | updated verdict → node 8c |
| 8c | **Approver review** | Action Center task | case card §13 | decision |
| — | *SLA on 8c* | Timer 48h | | escalate to next tier's approver, mark `ESCALATED` |
| 9C | **Apply: consolidate** | Data Service updates | related PRs | status → Consolidated; create consolidated review at correct tier |
| 9R | **Apply: release** | Data Service update | PR | status → Released |
| 9X | **Apply: reject** | Data Service update | PR(s) | status → Rejected |
| 9U | **Apply: unverified hold** | Data Service update | PR | status → Unverified (fail closed); notify procurement ops |
| 10 | **Write SplitCase** | Data Service create/update | everything | audit record incl. `runLog` |
| 11 | **Notify** | Connector (Outlook/Gmail/Teams/Slack) | template + case | requester + manager notified |
| 12 | **Repeat-offender check** (stretch) | Data Service query + decision | requesterId | ≥3 confirmed in 90d → notify Internal Audit |

### Gateway logic (node 7)
| Condition | Route |
|---|---|
| verdict = NOT_SPLIT AND legitException ≠ NONE AND score < 60 | 9R Release + log |
| verdict = NOT_SPLIT AND score ≥ 60 | **8c Approver review (guardrail)** |
| verdict = LIKELY_SPLIT AND suggestedAction = ASK_REQUESTER AND no justification yet | 8a Requester justification |
| verdict = LIKELY_SPLIT (otherwise) | 8c Approver review |
| verdict = SPLIT | 8c Approver review (pre-selected recommendation: CONSOLIDATE) |
| verdict = FAILED | 8c Approver review with rule evidence only |

### Notification templates (`templates/notifications.md`)
- **Released** — "Your PR {prId} passed SplitSentinel checks."
- **Held for review** — "PR {prId} has been grouped with {relatedPrIds} (combined ₹{amount}) and sent to {approverRole} for review."
- **Justification requested** — "Please explain why these PRs are separate requirements, or consolidate them."
- **Consolidated** — "PRs {ids} have been consolidated and routed for {tier} approval / competitive bidding."
- **Escalated** — "Review not completed within 48h; escalated to {nextApprover}."
- **Unverified** — "SplitSentinel could not verify PR {prId}; it is on hold. Procurement ops has been notified."

---

## 13. Human-in-the-loop design

### 13.1 Action Center review task — case card
**Header:** "Possible split purchase — combined ₹{combinedAmount} ({requiredTier})"

| Section | Content |
|---|---|
| Summary | requester, cost centre, vendor, project |
| Related PRs table | id, date, description, qty, amount, status |
| Rule evidence | score, patterns fired (human-readable labels) |
| Agent assessment | verdict, confidence, reasoning, legit exception |
| Requester justification | if collected |
| Policy excerpt | the relevant clause |

**Decision (required):**
- `CONSOLIDATE` — merge and route for correct-tier approval / RFQ
- `APPROVE_SEPARATE` — approve as separate PRs (**comment mandatory**)
- `REJECT` — reject (comment mandatory)
- `FALSE_POSITIVE` — not a split; feeds tuning data

**Assignment:** user/group holding `approverRole` of the **combined** tier (not the anchor PR's tier).
**SLA:** 48h → escalate one tier up.

### 13.2 Requester justification form
- Read-only: the grouped PRs and why they were grouped.
- Choice: "These are separate requirements" / "I will consolidate them".
- Free text: justification (min 30 characters).
- Timeout: 24h → proceed to approver review without justification.

---

## 14. Error handling and resilience

| Failure | Detection | Handling | Final state |
|---|---|---|---|
| Data Service read fails | node error | retry ×3 with backoff | **fail closed** → Unverified hold + ops notified |
| Rule script throws | node error | log stack in `runLog` | route to approver review with "rules failed" |
| Agent timeout / LLM error | node error | retry once | `FAILED` → approver review with rule evidence |
| Agent returns invalid JSON / schema | validation node | retry once with error appended | `FAILED` → approver review |
| Agent cites unknown PR ids | validation node | strip unknown ids, log, retry once | proceed with corrected ids or FAILED |
| Agent amount / tier wrong | validation node | overwrite with computed values, log | proceed |
| Requester doesn't respond | 24h timer | continue without justification | approver review |
| Approver doesn't act | 48h SLA | escalate to next tier | `ESCALATED` |
| Notification connector fails | node error | retry ×2; log; don't block the case | case continues |
| Duplicate trigger for same PR | check existing SplitCase for anchorPrId | skip run | idempotent |

**Principle:** never auto-approve on uncertainty. A failure always ends in a hold or a human.

---

## 15. Testing and evaluations

### 15.1 Unit tests (rule engine, local)
- `rules/score.test.js` — one test per signal + threshold edges (exactly ₹1,00,000, 84.9% vs 85%, 72h boundary).

### 15.2 Scenario evaluations (end-to-end + agent evals)
| ID | Scenario | Expected verdict | Expected route |
|---|---|---|---|
| T1 | Single clean PR, no history | — (agent not run) | Released |
| T2 | 3 × ₹1.45L, same requester/vendor, 3 days | SPLIT | Approver review (Dept Head), CONSOLIDATE |
| T3 | Laptops + chargers + docks, same project, 6 days | LIKELY_SPLIT / SPLIT | Approver review |
| T4 | Monthly stationery, recurring vendor | NOT_SPLIT (RECURRING) | Released |
| T5 | Call-offs against valid blanket PO | NOT_SPLIT (BLANKET_PO) | Released |
| T6 | Two requesters, same CC, same vendor, same day | LIKELY_SPLIT | Approver review (collusion flag) |
| T7 | Same vendor, genuinely separate projects/sites | NOT_SPLIT (SEPARATE_PROJECT) | Released |
| T8 | Medium case + convincing justification | NOT_SPLIT after re-eval | Released or approver (if score ≥ 60) |
| T9 | Medium case + vague justification ("urgent") | LIKELY_SPLIT | Approver review |
| T10 | Data Service down | — | Unverified hold |
| T11 | Agent returns invalid output twice | FAILED | Approver review, rule evidence |
| T12 | Agent says NOT_SPLIT, score ≥ 60 | NOT_SPLIT | **Approver review (guardrail)** |
| T13 | Approver SLA timeout | — | Escalated |
| T14 | Duplicate trigger | — | Skipped (idempotent) |

### 15.3 Metrics to report
- Agent verdict accuracy, **precision** and **recall** for "split" (SPLIT + LIKELY_SPLIT) on a labelled set of ~25 cases (T-scenarios + variants).
- False-positive rate on clean PRs.
- Avg. agent latency and share of PRs that never reach the agent (cost efficiency).
- **Before/after table:** v1 prompt + weights vs. tuned version (documented in `docs/evaluation-results.md`).

---

## 16. Claude Code collaboration log

The submission form asks *how you built it with your coding agent*. Keep `docs/claude-code-log.md` updated as you go:

| Date | Goal | What I asked Claude Code | What it produced | What I changed / learned |
|---|---|---|---|---|
| 2026-11-04 | Idea + plan | brainstorm, analysis, this plan | plan file | locked SplitSentinel |
| … | | | | |

Capture at least these iteration rounds:
1. Entity design → seed generator → reviewed and fixed edge cases.
2. Rule engine v1 → unit tests found boundary bugs → fixed.
3. Agent prompt v1 → evals showed misses on T3/T7 → prompt v2.
4. Flow wiring → debugging a failed path → added retries/validation.
5. Final eval run → metrics table.

Commit after each round with clear messages; the git history is evidence of iteration.

---

## 17. Timeline and task breakdown

### Week 1 — Foundations (Nov 4–10)
| Day | Task | Done |
|---|---|---|
| Nov 4 | Plan locked (this file). Create GitHub repo + folder structure. | ☐ |
| Nov 5 | Verify tenant: Maestro Flow, Agents, Data Service, Action Center, connectors (§21). Install VS Code extension. Hello-world Flow run. | ☐ |
| Nov 6 | Create 6 Data Service entities (§7). | ☐ |
| Nov 7 | Write `generate-seed.js` with Claude Code; generate CSVs; import into Data Service. | ☐ |
| Nov 8 | Write procurement policy doc (§8.2). | ☐ |
| Nov 9–10 | Rule engine `score.js` + unit tests. | ☐ |

### Week 2 — Core intelligence (Nov 11–17)
| Day | Task | Done |
|---|---|---|
| Nov 11 | Flow skeleton: trigger → load → rule engine → low-risk release. | ☐ |
| Nov 12 | Agent v1: prompt, schemas, grounding. | ☐ |
| Nov 13 | Validation node + retry loop. | ☐ |
| Nov 14 | Gateway + guardrail logic. | ☐ |
| Nov 15–16 | Build eval set (`eval-set.json`), first eval run, record baseline. | ☐ |
| Nov 17 | Prompt v2 tuning; re-run evals. | ☐ |

### Week 3 — Humans and resilience (Nov 18–23)
| Day | Task | Done |
|---|---|---|
| Nov 18 | Action Center review form + assignment by combined tier. | ☐ |
| Nov 19 | Requester justification step + agent re-evaluation. | ☐ |
| Nov 20 | SLA timers + escalation. | ☐ |
| Nov 21 | Error paths: fail-closed hold, connector retries, idempotency. | ☐ |
| Nov 22 | Notifications via connector. SplitCase audit writes + `runLog`. | ☐ |
| Nov 23 | Buffer / catch-up. | ☐ |

### Week 4 — Prove it and ship (Nov 24–30)
| Day | Task | Done |
|---|---|---|
| Nov 24 | Run all T1–T14 end-to-end; fix bugs. | ☐ |
| Nov 25 | Final eval metrics; `evaluation-results.md`. | ☐ |
| Nov 26 | Stretch: repeat-offender alert / P8 sweep (only if green). | ☐ |
| Nov 27 | Architecture diagram, README, Claude Code write-up. | ☐ |
| Nov 28 | Record demo video; edit. | ☐ |
| Nov 29 | Fill forum form; test all links in an incognito window. | ☐ |
| **Nov 30** | **Submit** (aim for morning IST; don't leave to the last hour). | ☐ |

---

## 18. Demo plan

**Length:** 3–5 minutes. **Format:** screen recording with voice-over, uploaded as public/unlisted YouTube or Google Drive (anyone with link).

| Time | Scene | Shows |
|---|---|---|
| 0:00–0:20 | Problem: approval matrix; "Priya needs ₹4.35L of laptops, her limit is ₹1.5L." | Real-world relevance |
| 0:20–1:00 | Priya submits PR #3 → Flow triggers → rule score 70, patterns P1/P2/P6 | Trigger, rules |
| 1:00–1:40 | Project Apollo case: agent groups laptops + chargers + docks (rules alone scored low) | Agent innovation |
| 1:40–2:20 | Action Center task goes to Dept Head for the combined amount → CONSOLIDATE → PR statuses update, notifications sent | HITL, integrations |
| 2:20–2:50 | Stationery case released as RECURRING; guardrail case T12 forced to human | Precision, guardrail |
| 2:50–3:20 | Kill Data Service access → retries → Unverified hold | Resilience |
| 3:20–3:50 | Eval table: v1 vs v2 precision/recall; SplitCase audit records | Build quality |
| 3:50–4:10 | Roadmap + how Claude Code helped | Coding agent story |

---

## 19. Submission checklist

**Forum post**
- [ ] Posted in the challenge category with tag `maestro-automate-challenge`
- [ ] Title: *SplitSentinel: an agent that catches split purchases before they reach a PO*
- [ ] Every form field completed:
  - [ ] The problem
  - [ ] Demo of the workflow running (video link)
  - [ ] Solution files (GitHub repo + exported Flow package)
  - [ ] How it was built with the coding agent (link to `claude-code-log.md` + summary)
  - [ ] What I liked / found surprising

**Files and access**
- [ ] GitHub repo public; README explains setup in ≤ 10 steps
- [ ] Exported Flow project / package included
- [ ] Seed CSVs + entity definitions included so reviewers can reproduce
- [ ] Video viewable without sign-in or access request
- [ ] All links tested in an incognito window
- [ ] No secrets, tokens or personal data in the repo

---

## 20. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Tenant lacks a feature (e.g. Data Service trigger, Agents) | High | Verify on Nov 5 (§21); fallback trigger = manual run or form trigger with `prId` |
| `uip` CLI install problems | Medium | Not required — run/debug/publish from the VS Code extension or Studio Web |
| LLM non-determinism breaks evals | Medium | Structured output, low temperature, validation node, report results over multiple runs |
| False positives make demo look noisy | Medium | Score threshold before agent, legit-exception list, tune weights with evals |
| Scope creep | High | Stretch goals only after Nov 25 if all T-scenarios pass |
| Running out of AI Units / quota | Medium | Low-risk PRs skip the agent; keep eval set small (~25) |
| Last-minute submission issues | High | Submit by Nov 29–30 morning; links tested in incognito |

---

## 21. Open questions to verify early (Nov 5)

- [ ] Which trigger types does Maestro Flow support in my tenant (Data Service record event? Integration Service event? form? schedule? manual)?
- [ ] Can a Flow script node run JavaScript or Python? Which libraries are available?
- [ ] How does the agent node accept structured input and enforce an output schema?
- [ ] Can the agent use Context Grounding for the policy doc, or must the policy be inline?
- [ ] How are Action Center tasks created from a Flow, and can assignment be dynamic (by role/group)?
- [ ] Are timers / SLA escalations supported in a short-running Flow, or should SLA be handled by Action Center task SLA settings?
- [ ] Retry configuration per node — built-in or manual loop?
- [ ] How do Flow evaluations / test runs work in the extension (for the eval story)?
- [ ] How to export the Flow project for sharing (package vs. source folder)?

Record answers in `docs/claude-code-log.md` and adjust §12 node types accordingly.

---

## 22. Roadmap (post-challenge)

- Live ERP connectors (SAP S/4HANA, Oracle, Coupa, Ariba) via Integration Service.
- Vendor-side invoice splitting sweep (P8) and P-card transaction feeds.
- Repeat-offender analytics dashboard by cost centre.
- Learning loop: `FALSE_POSITIVE` decisions automatically re-weight rules.
- Multi-currency and multi-entity approval matrices.
- Publish to the UiPath Flow Library.
