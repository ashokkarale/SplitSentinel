# SplitSentinel — Data Fabric entities

Tenant-level native entities. All business keys are `STRING` and the Flow looks records up by these keys (not by Data Fabric `Id`), so every entity can be bulk-loaded from `data/seed/*.csv`. Enumerations (role, status, verdict…) are `STRING` with the allowed values listed here and enforced by the Flow.

Types follow the Data Fabric UI-safe set: `DECIMAL` (precision 0 for whole numbers, 2 for money), `DATETIME_WITH_TZ` for timestamps, `DATE` for dates.

## Employee
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| employeeId | STRING(20) | ✓ | ✓ | E101… |
| name | STRING(100) | ✓ | | |
| email | STRING(200) | | | |
| managerId | STRING(20) | | | → Employee.employeeId |
| costCenter | STRING(20) | ✓ | | CC-IT, CC-OPS, CC-FIN, CC-MKT |
| approvalLimit | DECIMAL(2) | | | INR |
| role | STRING(30) | ✓ | | Requester, LineManager, DeptHead, CFO, Audit, ProcurementOps |

## Vendor
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| vendorId | STRING(20) | ✓ | ✓ | V001… |
| name | STRING(100) | ✓ | | |
| category | STRING(50) | ✓ | | |
| isRecurring | BOOLEAN | | | recurring-spend vendor |
| contactEmail | STRING(200) | | | |

## BlanketPO
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| blanketPoId | STRING(20) | ✓ | ✓ | BPO-001… |
| vendorId | STRING(20) | ✓ | | → Vendor.vendorId |
| category | STRING(50) | | | |
| approvedAmount | DECIMAL(2) | | | |
| consumedAmount | DECIMAL(2) | | | |
| validFrom | DATE | ✓ | | |
| validTo | DATE | ✓ | | |
| approvedBy | STRING(20) | | | → Employee.employeeId |

## ApprovalMatrix
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| tierId | STRING(5) | ✓ | ✓ | T1–T4 |
| minAmount | DECIMAL(2) | ✓ | | inclusive |
| maxAmount | DECIMAL(2) | | | exclusive; empty = no cap |
| approverRole | STRING(30) | ✓ | | |
| quotesRequired | DECIMAL(0) | | | |
| rfqRequired | BOOLEAN | | | |

## PurchaseRequisition
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| prId | STRING(20) | ✓ | ✓ | PR-1001… |
| requesterId | STRING(20) | ✓ | | → Employee.employeeId |
| costCenter | STRING(20) | ✓ | | cost centre charged |
| projectCode | STRING(30) | | | |
| vendorId | STRING(20) | ✓ | | → Vendor.vendorId |
| category | STRING(50) | | | |
| description | STRING(1000) | ✓ | | |
| quantity | DECIMAL(0) | | | |
| unitPrice | DECIMAL(2) | | | |
| amount | DECIMAL(2) | ✓ | | INR |
| currency | STRING(3) | | | INR |
| deliverySite | STRING(100) | | | |
| blanketPoRef | STRING(20) | | | → BlanketPO.blanketPoId |
| isEmergency | BOOLEAN | | | |
| createdAt | DATETIME_WITH_TZ | ✓ | | |
| status | STRING(20) | ✓ | | Draft, Submitted, UnderReview, OnHold, Unverified, Released, Consolidated, Rejected |
| splitCaseId | STRING(30) | | | → SplitCase.caseId |

## SplitCase (audit trail)
| Field | Type | Required | Unique | Notes |
|---|---|---|---|---|
| caseId | STRING(30) | ✓ | ✓ | `SC-<anchorPrId>` |
| anchorPrId | STRING(20) | ✓ | | idempotency key |
| relatedPrIds | STRING(2000) | | | comma-separated |
| combinedAmount | DECIMAL(2) | | | |
| ruleScore | DECIMAL(0) | | | 0–100 |
| rulePatterns | STRING(200) | | | comma-separated codes |
| ruleSignals | MULTILINE_TEXT(4000) | | | JSON |
| agentVerdict | STRING(20) | | | SPLIT, LIKELY_SPLIT, NOT_SPLIT, NOT_RUN, FAILED |
| agentConfidence | DECIMAL(2) | | | |
| agentLegitException | STRING(30) | | | NONE, RECURRING, BLANKET_PO, SEPARATE_PROJECT, EMERGENCY, STAGGERED_DELIVERY |
| agentReasoning | MULTILINE_TEXT(4000) | | | |
| requiredApprovalTier | STRING(5) | | | |
| requesterJustification | MULTILINE_TEXT(4000) | | | |
| humanDecision | STRING(20) | | | CONSOLIDATE, APPROVE_SEPARATE, REJECT, FALSE_POSITIVE, ESCALATED |
| humanComment | MULTILINE_TEXT(4000) | | | |
| decidedBy | STRING(100) | | | |
| decidedAt | DATETIME_WITH_TZ | | | |
| finalOutcome | STRING(20) | | | Released, Consolidated, Rejected, Unverified, Escalated |
| runLog | MULTILINE_TEXT(10000) | | | step trace |

## Test records added live (not in the seed files)

| prId | Purpose |
|---|---|
| PR-2091 | Gmail draft test (manual real run) |
| PR-2092 | Event-trigger test (processed automatically after deploy) |
| PR-2093 | Event-trigger test after the v1.0.1 upgrade |
| PR-2094 | Event-trigger test after the v1.0.2 upgrade |
| PR-2101, PR-2102 | Demo split history, see `data/demo/` |
| PR-2103 | Demo split, reviewed by the user (Approve separately) |
| PR-2104 | Coded Action App test on v1.0.3 (Rejected with all related PRs) |
| PR-2105, PR-2106 | Borderline test on v1.0.4; the agent cleared PR-2106 as a separate need (Released, no task) |
| PR-2107 | Follow-up to PR-2105; LIKELY_SPLIT → approver Rejected PR-2105 and PR-2107 |
| PR-2108, PR-2109 | Explain-app test on v1.0.4: requester explained, agent re-judged, approver kept them separate (Released) |
| PR-2110, PR-2111 | v1.0.5 fix test: review note for the rules' wider group, decidedBy, linked PRs on Keep separate |

## Loading seed data

```powershell
node data/generate-seed.js                      # regenerate CSV/JSON
uip df entities list --native-only --output json # resolve entity ids
uip df records import <entity-id> --file data/seed/<file>.csv --output json
```
CSV headers match field display names (the same as the names above).
