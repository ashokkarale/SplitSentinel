import { readFileSync } from "node:fs";
import {
  flow, manual, script, inlineAgent, hitl, dataFabricRead, dataFabricCreate, dataFabricUpdate,
  out, v, lit, js, tmpl, types,
} from "@uipath/maestro-builder-sdk";

// SplitSentinel: checks a submitted purchase requisition for split purchasing.
// Rule engine and agent assets live at the repo root and are inlined at compile time,
// so rules/score.js stays the single source of the scoring logic.

const repo = (p: string) => readFileSync(new URL("../../../" + p, import.meta.url), "utf8");
// The Node.js export footer has no meaning in the Flow script runtime, so it is dropped.
const SCORE_SRC = repo("rules/score.js").replace(/\nif \(typeof module[\s\S]*$/, "\n");
const POLICY = repo("data/policy/procurement-policy.md");
const SYSTEM_PROMPT = repo("agent/system-prompt.md").replace("{{policy}}", POLICY);

const MODEL = "anthropic.claude-sonnet-4-6";

const AGENT_RETURNS = {
  verdict: "string",
  confidence: "number",
  patterns: "array",
  relatedPrIds: "array",
  combinedAmount: "number",
  requiredApprovalTier: "string",
  competitiveBidRequired: "boolean",
  legitException: "string",
  reasoning: "string",
  suggestedAction: "string",
} as const;

// Builds the rule-engine script: normalise Data Fabric rows, score the anchor PR, and
// prepare everything later steps need (agent payload, record ids, amounts).
const RULES_CODE = `
${SCORE_SRC}
function lc(o) {
  var r = {};
  Object.keys(o || {}).forEach(function (k) { r[k.charAt(0).toLowerCase() + k.slice(1)] = o[k]; });
  return r;
}
function rows(step) {
  var o = $vars[step] && $vars[step].output;
  return ((o && o.results) || []).map(lc);
}
function strip(p) {
  return { prId: p.prId, requesterId: p.requesterId, costCenter: p.costCenter, projectCode: p.projectCode || null,
    vendorId: p.vendorId, category: p.category, description: p.description, quantity: p.quantity,
    amount: Number(p.amount), deliverySite: p.deliverySite || null, blanketPoRef: p.blanketPoRef || null,
    isEmergency: p.isEmergency === true, createdAt: p.createdAt, status: p.status };
}
var prId = $vars.prId;
var prs = rows('loadPrs');
var anchor = prs.filter(function (p) { return p.prId === prId; })[0];
if (!anchor) return { route: 'NOT_FOUND', score: 0, patterns: '', signals: '[]', groupPrIds: [], knownPrIds: [] };
var employees = rows('loadEmployees');
var vendors = rows('loadVendors');
var matrix = rows('loadMatrix');
var blanketPos = rows('loadBlankets');
// Fail closed: without reference data the PR can't be checked, so it is held.
if (!matrix.length || !employees.length || !vendors.length) {
  return { route: 'UNVERIFIED', score: 0, patterns: '', signals: '[]', groupPrIds: [prId], knownPrIds: [prId],
    recordIds: (function () { var o = {}; o[prId] = anchor.id; return o; })(), amounts: {}, combinedAmount: Number(anchor.amount),
    combinedTier: null, summary: '', agentInput: '{}', matrix: [] };
}
var requester = employees.filter(function (e) { return e.employeeId === anchor.requesterId; })[0] || {};
var vendor = vendors.filter(function (x) { return x.vendorId === anchor.vendorId; })[0] || {};
var r = scorePrs(anchor, prs, { approvalMatrix: matrix, requester: requester, vendor: vendor, blanketPos: blanketPos });
var group = prs.filter(function (p) { return r.groupPrIds.indexOf(p.prId) >= 0; });
var recordIds = {}, amounts = {};
group.forEach(function (p) { recordIds[p.prId] = p.id; amounts[p.prId] = Number(p.amount); });
var manager = employees.filter(function (e) { return e.employeeId === requester.managerId; })[0] || {};
var agentInput = {
  anchorPr: strip(anchor),
  candidatePrs: group.filter(function (p) { return p.prId !== prId; }).map(strip),
  ruleResult: { score: r.score, patterns: r.patterns, signals: r.signals, combinedAmount: r.combinedAmount,
    anchorTier: r.anchorTier, combinedTier: r.combinedTier, crossesTier: r.crossesTier,
    requesterLimit: r.requesterLimit, exceedsRequesterLimit: r.exceedsRequesterLimit },
  approvalMatrix: matrix.map(function (t) { return { tierId: t.tierId, minAmount: t.minAmount, maxAmount: t.maxAmount,
    approverRole: t.approverRole, quotesRequired: t.quotesRequired, rfqRequired: t.rfqRequired }; }),
  vendor: { vendorId: vendor.vendorId, name: vendor.name, category: vendor.category, isRecurring: vendor.isRecurring === true },
  requester: { employeeId: requester.employeeId, name: requester.name, costCenter: requester.costCenter,
    role: requester.role, approvalLimit: requester.approvalLimit },
  blanketPos: blanketPos.map(function (b) { return { blanketPoId: b.blanketPoId, vendorId: b.vendorId,
    validFrom: b.validFrom, validTo: b.validTo, approvedAmount: b.approvedAmount }; })
};
var summary = group.map(function (p) {
  return p.prId + ' | ' + String(p.createdAt).slice(0, 10) + ' | ' + p.vendorId + ' | ' + p.description + ' | INR ' + Number(p.amount);
}).join('\\n');
return {
  route: r.route, score: r.score, patterns: r.patterns.join(','), signals: JSON.stringify(r.signals),
  groupPrIds: r.groupPrIds, knownPrIds: r.groupPrIds, recordIds: recordIds, amounts: amounts,
  anchorRecordId: anchor.id, combinedAmount: r.combinedAmount, combinedTier: r.combinedTier,
  requesterName: requester.name || anchor.requesterId, requesterEmail: requester.email || '',
  managerEmail: manager.email || '', agentInput: JSON.stringify(agentInput), summary: summary,
  matrix: agentInput.approvalMatrix
};
`;

const RULES_RETURNS = {
  route: "string", score: "number", patterns: "string", signals: "string",
  groupPrIds: "array", knownPrIds: "array", recordIds: "object", amounts: "object",
  anchorRecordId: "string", combinedAmount: "number", combinedTier: "string",
  requesterName: "string", requesterEmail: "string", managerEmail: "string",
  agentInput: "string", summary: "string", matrix: "array",
} as const;

// Validates one agent answer against the rule engine's data. On the final attempt an
// invalid answer becomes verdict FAILED, carrying the rule engine's grouping.
const validateCode = (step: string, finalAttempt: boolean) => `
${SCORE_SRC}
var a = null;
try { a = $vars.${step}.output || null; } catch (e) { a = null; }
var rules = $vars.rules.output;
var errors = [], corrections = [];
var VERDICTS = ['SPLIT', 'LIKELY_SPLIT', 'NOT_SPLIT'];
var EXCEPTIONS = ['NONE', 'RECURRING', 'BLANKET_PO', 'SEPARATE_PROJECT', 'EMERGENCY', 'STAGGERED_DELIVERY'];
var ACTIONS = ['CONSOLIDATE', 'ASK_REQUESTER', 'APPROVE'];
if (!a || typeof a !== 'object') errors.push('no structured answer returned');
else {
  if (VERDICTS.indexOf(a.verdict) < 0) errors.push('verdict must be one of ' + VERDICTS.join(', '));
  if (EXCEPTIONS.indexOf(a.legitException) < 0) errors.push('legitException must be one of ' + EXCEPTIONS.join(', '));
  if (ACTIONS.indexOf(a.suggestedAction) < 0) errors.push('suggestedAction must be one of ' + ACTIONS.join(', '));
  if (typeof a.reasoning !== 'string' || !a.reasoning.trim()) errors.push('reasoning is required');
}
var ok = errors.length === 0;
var fallback = { verdict: 'FAILED', confidence: 0, patterns: [], relatedPrIds: rules.groupPrIds,
  combinedAmount: rules.combinedAmount, requiredApprovalTier: rules.combinedTier, competitiveBidRequired: false,
  legitException: 'NONE', reasoning: 'Agent answer invalid: ' + errors.join('; '), suggestedAction: 'CONSOLIDATE' };
if (!ok) return Object.assign({ ok: false, errors: errors.join('; '), corrections: '' }, ${finalAttempt} ? fallback : {});
var ids = (Array.isArray(a.relatedPrIds) ? a.relatedPrIds : String(a.relatedPrIds || '').split(','))
  .map(function (x) { return String(x).trim(); }).filter(function (x) { return x; });
var known = rules.knownPrIds;
var unknown = ids.filter(function (x) { return known.indexOf(x) < 0; });
if (unknown.length) corrections.push('removed unknown PR ids ' + unknown.join(', '));
ids = ids.filter(function (x) { return known.indexOf(x) >= 0; });
if (ids.indexOf($vars.prId) < 0) ids.unshift($vars.prId);
var amount = ids.reduce(function (s, x) { return s + (rules.amounts[x] || 0); }, 0);
if (Math.abs(Number(a.combinedAmount) - amount) > 1) corrections.push('combinedAmount ' + a.combinedAmount + ' -> ' + amount);
var t = tierFor(amount, rules.matrix).tier || {};
if (a.requiredApprovalTier !== t.tierId) corrections.push('requiredApprovalTier ' + a.requiredApprovalTier + ' -> ' + t.tierId);
return { ok: true, errors: '', corrections: corrections.join('; '), verdict: a.verdict,
  confidence: Number(a.confidence) || 0, patterns: Array.isArray(a.patterns) ? a.patterns : [],
  relatedPrIds: ids, combinedAmount: amount, requiredApprovalTier: t.tierId,
  competitiveBidRequired: t.rfqRequired === true || String(t.rfqRequired) === 'true',
  legitException: a.legitException, reasoning: a.reasoning, suggestedAction: a.suggestedAction };
`;

// Gateway + guardrail. The agent can clear a case only with a legitimate exception and a
// rule score below 60; anything else goes to a person.
const gatewayCode = (allowAsk: boolean) => `
var r = $vars.agentResult || {};
var score = $vars.rules.output.score;
if (r.verdict === 'NOT_SPLIT' && r.legitException !== 'NONE' && score < 60) return { decision: 'RELEASE', path: 'AGENT_RELEASE' };
if (${allowAsk} && r.verdict === 'LIKELY_SPLIT' && r.suggestedAction === 'ASK_REQUESTER') return { decision: 'ASK_REQUESTER', path: 'ASK_REQUESTER' };
var guard = r.verdict === 'NOT_SPLIT';
return { decision: 'REVIEW', path: guard ? 'GUARDRAIL_REVIEW' : (r.verdict === 'FAILED' ? 'FAILED_REVIEW' : 'APPROVER_REVIEW') };
`;

const FINALIZE_CODE = `
var st = $vars.finalPrStatus;
var rules = $vars.rules.output;
var a = $vars.agentResult || {};
var related = (a.relatedPrIds && a.relatedPrIds.length) ? a.relatedPrIds : rules.groupPrIds;
var targets = (st === 'Consolidated' || st === 'Rejected') ? related : [$vars.prId];
var log = [
  'rules: score ' + rules.score + ' [' + rules.patterns + '] route ' + rules.route,
  'agent: ' + (a.verdict || 'NOT_RUN') + (a.corrections ? ' (corrected: ' + a.corrections + ')' : ''),
  'path: ' + $vars.path,
  'human: ' + ($vars.humanDecision || 'none'),
  'final: ' + st + ' -> ' + targets.join(',')
].join('\\n');
return {
  caseId: 'SC-' + $vars.prId,
  targetRecordIds: targets.map(function (x) { return rules.recordIds[x]; }).filter(function (x) { return x; }),
  relatedPrIds: related.join(','),
  agentVerdict: a.verdict || 'NOT_RUN',
  runLog: log
};
`;

// Form text is computed in a script step: human-task fields bind to variable paths only.
const REVIEW_CARD_CODE = `
var a = $vars.agentResult || {};
var rules = $vars.rules.output;
var amount = a.combinedAmount || rules.combinedAmount;
var tier = a.requiredApprovalTier || rules.combinedTier;
var tierRow = (rules.matrix || []).filter(function (t) { return t.tierId === tier; })[0] || {};
return {
  caseSummary: 'PR ' + $vars.prId + ' (' + rules.requesterName + ') is grouped with ' + (a.relatedPrIds || rules.groupPrIds).join(', ')
    + '. Combined INR ' + amount + ' needs tier ' + tier + ' approval (' + (tierRow.approverRole || '?') + ')'
    + (a.competitiveBidRequired ? ' and a competitive bid (RFQ).' : '.'),
  ruleEvidence: 'Score ' + rules.score + ': ' + JSON.parse(rules.signals).map(function (s) { return s.code + ' ' + (s.points > 0 ? '+' : '') + s.points + ' ' + s.detail; }).join('; '),
  agentAssessment: (a.verdict || 'NOT_RUN') + ' (' + (a.legitException || 'NONE') + ', confidence ' + (a.confidence || 0) + '): ' + (a.reasoning || '')
    + (a.corrections ? ' [corrected: ' + a.corrections + ']' : ''),
  requesterJustification: $vars.justification || 'none',
  title: 'SplitSentinel: possible split, PR ' + $vars.prId + ' (' + tier + ' approval)'
};
`;

const ASK_CARD_CODE = `
var a = $vars.agentResult || {};
return { caseSummary: 'Your requisitions ' + (a.relatedPrIds || []).join(', ') + ' look like one requirement (combined INR '
  + a.combinedAmount + ', tier ' + a.requiredApprovalTier + '). Explain why they are separate requirements, or choose Consolidate.' };
`;

const reviewFields = [
  { id: "caseSummary", label: "Possible split", type: "string", direction: "input" as const, value: out("reviewCard", "caseSummary") },
  { id: "relatedPrs", label: "Related PRs (id | date | vendor | item | amount)", type: "string", direction: "input" as const, value: out("rules", "summary") },
  { id: "ruleEvidence", label: "Rule evidence", type: "string", direction: "input" as const, value: out("reviewCard", "ruleEvidence") },
  { id: "agentAssessment", label: "Agent assessment", type: "string", direction: "input" as const, value: out("reviewCard", "agentAssessment") },
  { id: "requesterJustification", label: "Requester justification", type: "string", direction: "input" as const, value: out("reviewCard", "requesterJustification") },
  { id: "comment", label: "Decision comment", type: "string", direction: "output" as const },
];

export default flow("08cdc015-6874-49a8-ac05-743f6edf1bf6")
  .schemaVersion("1.9")
  .name("SplitSentinel")
  .trigger(manual(), { version: "1.0" })
  .input({ requisitionId: { type: types.string, shared: "prId" } })
  .output({
    caseId: types.string, outcome: types.string, path: types.string,
    ruleScore: types.number, agentVerdict: types.string, humanDecision: types.string,
  })
  .var("finalPrStatus", types.string, "Released")
  .var("path", types.string, "")
  .var("needsReview", types.boolean, false)
  .var("agentResult", types.object, {})
  .var("justification", types.string, "")
  .var("humanDecision", types.string, "")
  .var("humanComment", types.string, "")

  // 1. Idempotency: one SplitCase per anchor PR.
  .step("existingCase", dataFabricRead({
    entity: "SplitCase", resultMode: "multiple", limit: 1,
    filters: [{ field: "anchorPrId", value: v("prId") }],
  }))
  .branch("alreadyChecked", js`($vars.existingCase.output.results || []).length > 0`,
    (yes) => yes.return({ caseId: tmpl`SC-${v("prId")}`, outcome: lit("Skipped"), path: lit("SKIPPED_DUPLICATE"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }))

  // 2. Load context. Data Fabric reads have no error port: a failed read faults the run,
  // so nothing is released; empty reference data is held by the rule engine (UNVERIFIED).
  .step("loadPrs", dataFabricRead({ entity: "PurchaseRequisition", resultMode: "multiple", limit: 1000, sort: { field: "createdAt", direction: "desc" } }))
  .step("loadEmployees", dataFabricRead({ entity: "Employee", resultMode: "multiple", limit: 1000 }))
  .step("loadVendors", dataFabricRead({ entity: "Vendor", resultMode: "multiple", limit: 1000 }))
  .step("loadMatrix", dataFabricRead({ entity: "ApprovalMatrix", resultMode: "multiple", limit: 10 }))
  .step("loadBlankets", dataFabricRead({ entity: "BlanketPO", resultMode: "multiple", limit: 1000 }))

  // 3. Deterministic rule engine.
  .step("rules", script({ code: RULES_CODE, returns: RULES_RETURNS }))
  .onError((h) => h.return({ caseId: lit(""), outcome: lit("Unverified"), path: lit("RULES_FAILED"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }))

  // 4. Route on the rule score.
  .switch("route", out("rules", "route"), [
    { value: "NOT_FOUND", body: (b) => b.return({ caseId: lit(""), outcome: lit("NotFound"), path: lit("PR_NOT_FOUND"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }) },
    { value: "RELEASE", body: (b) => b.step("ruleRelease", script({ code: 'return "RULES_RELEASE";' }),
        { updates: { path: lit("RULES_RELEASE"), finalPrStatus: lit("Released") } }) },
    { value: "UNVERIFIED", body: (b) => b.step("holdUnverified", script({ code: 'return "UNVERIFIED_HOLD";' }),
        { updates: { path: lit("UNVERIFIED_HOLD"), finalPrStatus: lit("Unverified") } }) },
  ], (agentArm) => agentArm
    // 5. Agent judgement, validated; one retry with the validation errors.
    .step("judge", inlineAgent({
      model: MODEL, temperature: 0,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: "Case data:\n{{input.caseData}}",
      inputs: { caseData: out("rules", "agentInput") },
      returns: AGENT_RETURNS,
    }))
    .onError((h) => h.stepToRef("check1"))
    .step("check1", script({ code: validateCode("judge", false), returns: "object" }), { updates: { agentResult: out("check1") } })
    .branch("retryNeeded", js`!$vars.check1.output.ok`,
      (retry) => retry
        .step("judgeRetry", inlineAgent({
          model: MODEL, temperature: 0,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: "Case data:\n{{input.caseData}}\n\nYour previous answer was rejected: {{input.errors}}. Answer again, fixing these problems.",
          inputs: { caseData: out("rules", "agentInput"), errors: out("check1", "errors") },
          returns: AGENT_RETURNS,
        }))
        .onError((h) => h.stepToRef("check2"))
        .step("check2", script({ code: validateCode("judgeRetry", true), returns: "object" }), { updates: { agentResult: out("check2") } }))

    // 6. Gateway and guardrail.
    .step("gateway", script({ code: gatewayCode(true), returns: { decision: "string", path: "string" } }), { updates: { path: out("gateway", "path") } })
    .switch("decision", out("gateway", "decision"), [
      { value: "RELEASE", body: (b) => b.step("agentRelease", script({ code: 'return "AGENT_RELEASE";' }),
          { updates: { finalPrStatus: lit("Released") } }) },
      { value: "ASK_REQUESTER", body: (b) => b
        // 7. Requester justification, then one re-evaluation (no second ask).
        .step("askCard", script({ code: ASK_CARD_CODE, returns: { caseSummary: "string" } }))
        .stepSwitch("requesterTask", hitl({
          variant: "quick-form",
          title: tmpl`SplitSentinel: explain PR ${v("prId")}`,
          priority: "Medium",
          labels: "SplitSentinel,Justification",
          fields: [
            { id: "caseSummary", label: "Why you are seeing this", type: "string", direction: "input",
              value: out("askCard", "caseSummary") },
            { id: "relatedPrs", label: "Related PRs", type: "string", direction: "input", value: out("rules", "summary") },
            { id: "justification", label: "Your explanation", type: "string", direction: "output" },
          ],
          outcomes: ["Explain", "Consolidate"],
        }), [
          { value: "Consolidate", body: (c) => c.step("requesterConsolidates", script({ code: 'return "REQUESTER_CONSOLIDATE";' }),
              { updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), path: lit("REQUESTER_CONSOLIDATED"), humanComment: lit("Requester chose to consolidate") } }) },
          { value: "Explain", body: (e) => e
            .step("keepJustification", script({ code: "return String($vars.requesterTask.output.justification || '');", returns: "string" }),
              { updates: { justification: out("keepJustification") } })
            .step("rejudge", inlineAgent({
              model: MODEL, temperature: 0,
              systemPrompt: SYSTEM_PROMPT,
              userPrompt: "Case data:\n{{input.caseData}}\n\nRequester justification:\n{{input.justification}}",
              inputs: { caseData: out("rules", "agentInput"), justification: v("justification") },
              returns: AGENT_RETURNS,
            }))
            .onError((h) => h.stepToRef("check3"))
            .step("check3", script({ code: validateCode("rejudge", true), returns: "object" }), { updates: { agentResult: out("check3") } })
            .step("gateway2", script({ code: gatewayCode(false), returns: { decision: "string", path: "string" } }),
              { updates: { path: out("gateway2", "path"), needsReview: js`$vars.gateway2.output.decision !== 'RELEASE'` } }) },
        ]) },
    ], (rev) => rev.step("markReview", script({ code: 'return "REVIEW";' }), { updates: { needsReview: lit(true) } })))

  // 8. Approver review, assigned for the combined amount.
  .branch("reviewNeeded", js`$vars.needsReview === true`,
    (yes) => yes
    .step("reviewCard", script({ code: REVIEW_CARD_CODE, returns: { caseSummary: "string", ruleEvidence: "string", agentAssessment: "string", requesterJustification: "string", title: "string" } }))
    .stepSwitch("approverReview", hitl({
      variant: "quick-form",
      title: out("reviewCard", "title"),
      priority: "High",
      labels: "SplitSentinel,Review",
      fields: reviewFields,
      outcomes: ["Consolidate", "Approve separately", "Reject", "False positive"],
    }), [
      { value: "Consolidate", body: (b) => b.step("decConsolidate", script({ code: 'return "CONSOLIDATE";' }),
          { updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), humanComment: out("approverReview", "comment") } }) },
      { value: "Approve separately", body: (b) => b.step("decApproveSeparate", script({ code: 'return "APPROVE_SEPARATE";' }),
          { updates: { finalPrStatus: lit("Released"), humanDecision: lit("APPROVE_SEPARATE"), humanComment: out("approverReview", "comment") } }) },
      { value: "Reject", body: (b) => b.step("decReject", script({ code: 'return "REJECT";' }),
          { updates: { finalPrStatus: lit("Rejected"), humanDecision: lit("REJECT"), humanComment: out("approverReview", "comment") } }) },
      { value: "False positive", body: (b) => b.step("decFalsePositive", script({ code: 'return "FALSE_POSITIVE";' }),
          { updates: { finalPrStatus: lit("Released"), humanDecision: lit("FALSE_POSITIVE"), humanComment: out("approverReview", "comment") } }) },
    ]))

  // 9. Apply the outcome and write the audit record.
  .step("finalize", script({ code: FINALIZE_CODE, returns: "object" }))
  .loop("applyStatus", out("finalize", "targetRecordIds"), (body) => body
    .step("setStatus", dataFabricUpdate({
      entity: "PurchaseRequisition",
      record: { byId: js`$vars.applyStatus.currentItem` },
      set: { status: v("finalPrStatus"), splitCaseId: out("finalize", "caseId") },
    })))
  .step("writeCase", dataFabricCreate({
    entity: "SplitCase",
    values: {
      caseId: out("finalize", "caseId"),
      anchorPrId: v("prId"),
      relatedPrIds: out("finalize", "relatedPrIds"),
      combinedAmount: js`$vars.agentResult.combinedAmount || $vars.rules.output.combinedAmount`,
      ruleScore: out("rules", "score"),
      rulePatterns: out("rules", "patterns"),
      ruleSignals: out("rules", "signals"),
      agentVerdict: out("finalize", "agentVerdict"),
      agentConfidence: js`$vars.agentResult.confidence || 0`,
      agentLegitException: js`$vars.agentResult.legitException || 'NONE'`,
      agentReasoning: js`$vars.agentResult.reasoning || ''`,
      requiredApprovalTier: js`$vars.agentResult.requiredApprovalTier || $vars.rules.output.combinedTier`,
      requesterJustification: v("justification"),
      humanDecision: v("humanDecision"),
      humanComment: v("humanComment"),
      decidedAt: js`new Date().toISOString()`,
      finalOutcome: v("finalPrStatus"),
      runLog: out("finalize", "runLog"),
    },
  }))
  .return({
    caseId: out("finalize", "caseId"), outcome: v("finalPrStatus"), path: v("path"),
    ruleScore: out("rules", "score"), agentVerdict: out("finalize", "agentVerdict"), humanDecision: v("humanDecision"),
  })
  .build();
