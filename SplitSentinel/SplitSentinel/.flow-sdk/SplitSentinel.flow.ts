import { readFileSync } from "node:fs";
import {
  flow, manual, onEvent, lookup, connector, script, inlineAgent, hitl, dataFabricRead, dataFabricCreate, dataFabricUpdate,
  out, v, lit, js, tmpl, types, at, dim,
} from "@uipath/maestro-builder-sdk";
import { RecordCreated } from "./connectors-local/uipath-uipath-dataservice.ts";
import { SendEmail } from "./connectors-local/uipath-google-gmail.ts";

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
// Only submitted PRs are checked for real; what-if runs may re-check a PR in any status.
if (!$vars.dryRun && anchor.status !== 'Submitted') {
  return { route: 'NOT_SUBMITTED', score: 0, patterns: '', signals: '[]', groupPrIds: [], knownPrIds: [] };
}
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
var targets = $vars.dryRun ? [] : (st === 'Consolidated' || st === 'Rejected') ? related : [$vars.prId];
var log = [
  'rules: score ' + rules.score + ' [' + rules.patterns + '] route ' + rules.route,
  'agent: ' + (a.verdict || 'NOT_RUN') + (a.corrections ? ' (corrected: ' + a.corrections + ')' : ''),
  'path: ' + $vars.path,
  'human: ' + ($vars.humanDecision || 'none'),
  'final: ' + st + ' -> ' + ($vars.dryRun ? 'what-if run, no PR updated' : targets.join(','))
].join('\\n');
return {
  caseId: ($vars.dryRun ? 'WHATIF-' + $vars.prId + '-' + Date.now() : 'SC-' + $vars.prId),
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

// Notification text per outcome (templates/notifications.md). Saved as a Gmail draft.
const NOTIFY_CODE = `
var rules = $vars.rules.output;
var a = $vars.agentResult || {};
var st = $vars.finalPrStatus;
var caseId = $vars.finalize.output.caseId;
var related = $vars.finalize.output.relatedPrIds;
var amount = a.combinedAmount || rules.combinedAmount;
var tier = a.requiredApprovalTier || rules.combinedTier;
var hi = 'Hi ' + rules.requesterName + ',\\n\\n';
var foot = '\\n\\nSplitSentinel case: ' + caseId;
var subject, body;
if (st === 'Consolidated') {
  subject = 'PRs ' + related + ' consolidated';
  body = hi + 'Your requisitions ' + related + ' were reviewed and consolidated into one requirement of INR ' + amount
    + '. It now goes through tier ' + tier + ' approval' + (a.competitiveBidRequired ? ' and a competitive bid (RFQ)' : '') + '.'
    + ($vars.humanComment ? '\\n\\nComment: ' + $vars.humanComment : '') + foot;
} else if (st === 'Rejected') {
  subject = 'PR ' + $vars.prId + ' rejected';
  body = hi + 'Requisition(s) ' + related + ' were rejected.' + ($vars.humanComment ? '\\n\\nComment: ' + $vars.humanComment : '') + foot;
} else if (st === 'Unverified') {
  subject = 'PR ' + $vars.prId + ' on hold: check could not be completed';
  body = hi + 'SplitSentinel could not load the data needed to check PR ' + $vars.prId + ', so it is on hold. Procurement operations will re-run the check.' + foot;
} else {
  subject = 'PR ' + $vars.prId + ' approved for normal routing';
  body = hi + 'Your purchase requisition ' + $vars.prId + ' passed the SplitSentinel check and continues through normal approval.'
    + ($vars.humanDecision ? '\\n\\nReviewer decision: ' + $vars.humanDecision + ($vars.humanComment ? ' (' + $vars.humanComment + ')' : '') : '') + foot;
}
return { to: rules.requesterEmail, cc: (st === 'Consolidated' || st === 'Rejected') ? rules.managerEmail : '', subject: 'SplitSentinel: ' + subject, body: body };
`;

const reviewFields = [
  { id: "caseSummary", label: "Possible split", type: "string", direction: "input" as const, value: out("reviewCard", "caseSummary") },
  { id: "relatedPrs", label: "Related PRs (id | date | vendor | item | amount)", type: "string", direction: "input" as const, value: out("rules", "summary") },
  { id: "ruleEvidence", label: "Rule evidence", type: "string", direction: "input" as const, value: out("reviewCard", "ruleEvidence") },
  { id: "agentAssessment", label: "Agent assessment", type: "string", direction: "input" as const, value: out("reviewCard", "agentAssessment") },
  { id: "requesterJustification", label: "Requester justification", type: "string", direction: "input" as const, value: out("reviewCard", "requesterJustification") },
  { id: "comment", label: "Decision comment", type: "string", direction: "output" as const },
];

// Canvas annotations. Sticky notes are inert: the platform skips them during validation
// and conversion, so they document the diagram without changing behaviour.
const NOTES = [
  { id: "noteEntry", color: "green", x: 0, y: 700, width: 300, height: 150,
    content: "TWO WAYS IN\n• Automatic: a new PurchaseRequisition record in Data Fabric starts the run.\n• Manual: pass requisitionId (and whatIf=true to re-check without changing anything)." },
  { id: "noteIdempotency", color: "white", x: 840, y: 540, width: 300, height: 150,
    content: "ONE CASE PER PR\nIf a SplitCase already exists for this PR, the run stops (duplicate trigger).\nWhat-if runs skip this check and write WHATIF-… audit rows instead." },
  { id: "noteFailClosed", color: "pink", x: 1440, y: 540, width: 330, height: 160,
    content: "FAIL CLOSED\nData Fabric reads have no error port: a failed read faults the run, so nothing is ever auto-released.\nMissing reference data (tiers, employees, vendors) holds the PR as Unverified." },
  { id: "noteRules", color: "blue", x: 2160, y: 540, width: 340, height: 170,
    content: "RULE ENGINE (rules/score.js, inlined at compile time)\nGroups related PRs from the last 30 days and scores 0–100.\n0–29: release, no agent call\n30–59: agent decides\n60–100: agent + mandatory human review" },
  { id: "noteAgent", color: "blue", x: 3360, y: 780, width: 330, height: 160,
    content: "AGENT + VALIDATION\nClaude Sonnet 4.6 judges whether the PRs are one need, grounded in the procurement policy.\nEvery answer is checked against the data (PR ids, amount, tier). Invalid → one retry → FAILED → human." },
  { id: "noteGuardrail", color: "pink", x: 3840, y: 760, width: 330, height: 160,
    content: "GUARDRAIL\nThe agent can clear a case only with a legitimate exception AND a rule score below 60.\nEverything else goes to a person — the agent never approves a high-risk case on its own." },
  { id: "noteRequester", color: "yellow", x: 4800, y: 780, width: 320, height: 150,
    content: "REQUESTER JUSTIFICATION (one round)\nOn mixed evidence the requester can explain or consolidate.\nThe agent re-judges with the explanation; vague reasons (\"urgent\") don't count." },
  { id: "noteApprover", color: "yellow", x: 6200, y: 820, width: 340, height: 170,
    content: "APPROVER REVIEW\nAssigned for the COMBINED amount's tier, with rule evidence, agent reasoning and any justification on the form.\nSLA/escalation is set in Action Center — Flow human tasks have no timeout." },
  { id: "noteAudit", color: "white", x: 8240, y: 60, width: 320, height: 150,
    content: "AUDIT TRAIL\nEvery run writes a SplitCase record: rule score + signals, agent verdict + reasoning, human decision, final outcome and a step-by-step run log." },
  { id: "noteNotify", color: "green", x: 8720, y: 760, width: 320, height: 150,
    content: "NOTIFICATIONS\nThe requester (and manager, on consolidate/reject) gets an email saved as a Gmail draft.\nSkipped on what-if runs; a mail failure never blocks the case." },
];

// Hand-authored canvas layout. Lanes: main path on y=320, release outcomes above it,
// retry / requester / approver paths below it, terminal ends in the bottom lane.
// Do not run `uip maestro flow format` after compile: it would replace this layout.
const LAYOUT = {
  nodes: {
    onPrCreated: at(0, 120), createdPr: at(240, 120), fromEvent: at(480, 120),
    start: at(480, 520),
    resolveRun: at(720, 320), existingCase: at(960, 320), alreadyChecked: at(1200, 320), end: at(1440, 120),
    loadPrs: at(1440, 320), loadEmployees: at(1680, 320), loadVendors: at(1920, 320), loadMatrix: at(2160, 320), loadBlankets: at(2400, 320),
    rules: at(2640, 320), end2: at(2880, 600),
    route: at(2880, 320), end3: at(3120, 600), end4: at(3120, 760),
    holdUnverified: at(3120, -240), ruleRelease: at(3120, -80),
    judge: at(3120, 320), check1: at(3360, 320), retryNeeded: at(3600, 320),
    judgeRetry: at(3840, 520), check2: at(4080, 520),
    gateway: at(4320, 320), decision: at(4560, 320),
    agentRelease: at(4800, -400), markReview: at(4800, 320),
    askCard: at(4800, 560), requesterTask: at(5040, 560), requesterConsolidates: at(5280, 560),
    keepJustification: at(5280, 760), rejudge: at(5520, 760), check3: at(5760, 760), gateway2: at(6000, 760),
    reviewNeeded: at(6240, 320),
    reviewCard: at(6480, 600), approverReview: at(6720, 568, dim(96, 160)),
    decConsolidate: at(6960, 480), decApproveSeparate: at(6960, 640), decReject: at(6960, 800), decFalsePositive: at(6960, 960),
    finalize: at(7200, 320),
    applyStatus: at(7440, 224, dim(560, 320)), setStatus: at(232, 112),
    writeCase: at(8240, 320), notifyNeeded: at(8480, 320),
    notifyText: at(8720, 560), notify: at(8960, 560), notifyDone: at(9200, 560),
    end5: at(9440, 320),
  },
  // The three release lanes run above the main path and drop into "Review?" just before it.
  edges: {
    "holdUnverified->reviewNeeded": { waypoints: [{ x: 6120, y: -192 }, { x: 6120, y: 368 }] },
    "ruleRelease->reviewNeeded": { waypoints: [{ x: 6150, y: -32 }, { x: 6150, y: 368 }] },
    "agentRelease->reviewNeeded": { waypoints: [{ x: 6180, y: -352 }, { x: 6180, y: 368 }] },
  },
};

export default flow("08cdc015-6874-49a8-ac05-743f6edf1bf6")
  .schemaVersion("1.9")
  .name("SplitSentinel")
  .trigger(manual(), { version: "1.0", label: "Manual check" })
  .input({ requisitionId: types.string, whatIf: types.boolean })
  // Second root: start automatically when a PurchaseRequisition record is created.
  // The event carries only the record Id, so the prefix looks the PR up to get its prId.
  .entryPoint("onPrCreated", onEvent(RecordCreated, {
    where: {
      entityScope: lookup(RecordCreated, "entityScope").byDisplayName("Tenant"),
      tenantEntityName: lookup(RecordCreated, "tenantEntityName").byDisplayName("PurchaseRequisition"),
    },
    connection: "dataFabric", folder: "shared",
  }), { label: "New PR created" }, (b) => b
    .step("createdPr", dataFabricRead({ entity: "PurchaseRequisition", filters: [{ field: "Id", value: js`$vars.onPrCreated.output.Id` }] }),
      { label: "Read new PR" })
    .step("fromEvent", script({ code: "var r = $vars.createdPr.output || {}; return String(r.prId || r.PrId || '');", returns: "string" }),
      { label: "Get PR id", updates: { prId: out("fromEvent"), dryRun: lit(false) } }))
  .output({
    caseId: types.string, outcome: types.string, path: types.string,
    ruleScore: types.number, agentVerdict: types.string, humanDecision: types.string,
  })
  .var("prId", types.string, "")
  .var("dryRun", types.boolean, false)
  .var("finalPrStatus", types.string, "Released")
  .var("path", types.string, "")
  .var("needsReview", types.boolean, false)
  .var("agentResult", types.object, {})
  .var("justification", types.string, "")
  .var("humanDecision", types.string, "")
  .var("humanComment", types.string, "")
  .stickyNotes(NOTES)
  .layout(LAYOUT)

  // 0. Resolve which PR this run is about: the manual root passes it as an input, the
  // event root has already set prId in its prefix.
  .step("resolveRun", script({
    code: "var id = $vars.prId || ''; var w = false;"
      + " try { if ($vars.start.output.requisitionId) { id = $vars.start.output.requisitionId; w = $vars.start.output.whatIf === true; } } catch (e) {}"
      + " return { prId: id, dryRun: w };",
    returns: { prId: "string", dryRun: "boolean" },
  }), { label: "Resolve PR", updates: { prId: out("resolveRun", "prId"), dryRun: out("resolveRun", "dryRun") } })

  // 1. Idempotency: one SplitCase per anchor PR.
  .step("existingCase", dataFabricRead({
    entity: "SplitCase", resultMode: "multiple", limit: 1,
    filters: [{ field: "anchorPrId", value: v("prId") }],
  }), { label: "Find case" })
  .branch("alreadyChecked", js`!$vars.dryRun && ($vars.existingCase.output.results || []).length > 0`,
    (yes) => yes.label("Yes: skip")
      .return({ caseId: tmpl`SC-${v("prId")}`, outcome: lit("Skipped"), path: lit("SKIPPED_DUPLICATE"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }),
    undefined, { label: "Checked before?" })

  // 2. Load context. Data Fabric reads have no error port: a failed read faults the run,
  // so nothing is released; empty reference data is held by the rule engine (UNVERIFIED).
  .step("loadPrs", dataFabricRead({ entity: "PurchaseRequisition", resultMode: "multiple", limit: 1000, sort: { field: "createdAt", direction: "desc" } }),
    { label: "Load PRs" })
  .step("loadEmployees", dataFabricRead({ entity: "Employee", resultMode: "multiple", limit: 1000 }), { label: "Load employees" })
  .step("loadVendors", dataFabricRead({ entity: "Vendor", resultMode: "multiple", limit: 1000 }), { label: "Load vendors" })
  .step("loadMatrix", dataFabricRead({ entity: "ApprovalMatrix", resultMode: "multiple", limit: 10 }), { label: "Load tiers" })
  .step("loadBlankets", dataFabricRead({ entity: "BlanketPO", resultMode: "multiple", limit: 1000 }), { label: "Load blanket POs" })

  // 3. Deterministic rule engine.
  .step("rules", script({ code: RULES_CODE, returns: RULES_RETURNS }), { label: "Score risk" })
  .onError((h) => h.return({ caseId: lit(""), outcome: lit("Unverified"), path: lit("RULES_FAILED"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }))

  // 4. Route on the rule score.
  .switch("route", out("rules", "route"), [
    { value: "NOT_SUBMITTED", label: "Not submitted",
      body: (b) => b.return({ caseId: lit(""), outcome: lit("Skipped"), path: lit("NOT_SUBMITTED"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }) },
    { value: "NOT_FOUND", label: "Not found",
      body: (b) => b.return({ caseId: lit(""), outcome: lit("NotFound"), path: lit("PR_NOT_FOUND"), ruleScore: lit(0), agentVerdict: lit("NOT_RUN"), humanDecision: lit("") }) },
    { value: "RELEASE", label: "Low risk",
      body: (b) => b.step("ruleRelease", script({ code: 'return "RULES_RELEASE";' }),
        { label: "Low-risk release", updates: { path: lit("RULES_RELEASE"), finalPrStatus: lit("Released") } }) },
    { value: "UNVERIFIED", label: "No ref. data",
      body: (b) => b.step("holdUnverified", script({ code: 'return "UNVERIFIED_HOLD";' }),
        { label: "Hold", updates: { path: lit("UNVERIFIED_HOLD"), finalPrStatus: lit("Unverified") } }) },
  ], (agentArm) => agentArm
    // 5. Agent judgement, validated; one retry with the validation errors.
    .step("judge", inlineAgent({
      model: MODEL, temperature: 0,
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: "Case data:\n{{input.caseData}}",
      inputs: { caseData: out("rules", "agentInput") },
      returns: AGENT_RETURNS,
    }), { label: "Agent judge" })
    .onError((h) => h.stepToRef("check1"))
    .step("check1", script({ code: validateCode("judge", false), returns: "object" }),
      { label: "Validate", updates: { agentResult: out("check1") } })
    .branch("retryNeeded", js`!$vars.check1.output.ok`,
      (retry) => retry.label("Yes: retry")
        .step("judgeRetry", inlineAgent({
          model: MODEL, temperature: 0,
          systemPrompt: SYSTEM_PROMPT,
          userPrompt: "Case data:\n{{input.caseData}}\n\nYour previous answer was rejected: {{input.errors}}. Answer again, fixing these problems.",
          inputs: { caseData: out("rules", "agentInput"), errors: out("check1", "errors") },
          returns: AGENT_RETURNS,
        }), { label: "Agent retry" })
        .onError((h) => h.stepToRef("check2"))
        .step("check2", script({ code: validateCode("judgeRetry", true), returns: "object" }),
          { label: "Validate retry", updates: { agentResult: out("check2") } }),
      undefined, { label: "Invalid?" })

    // 6. Gateway and guardrail.
    .step("gateway", script({ code: gatewayCode(true), returns: { decision: "string", path: "string" } }),
      { label: "Guardrail", updates: { path: out("gateway", "path") } })
    .switch("decision", out("gateway", "decision"), [
      { value: "RELEASE", label: "Cleared",
        body: (b) => b.step("agentRelease", script({ code: 'return "AGENT_RELEASE";' }),
          { label: "Agent cleared", updates: { finalPrStatus: lit("Released") } }) },
      { value: "ASK_REQUESTER", label: "Ask requester", body: (b) => b
        // 7. Requester justification, then one re-evaluation (no second ask).
        .step("askCard", script({ code: ASK_CARD_CODE, returns: { caseSummary: "string" } }), { label: "Draft question" })
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
          { value: "Consolidate", body: (c) => c
            .step("requesterConsolidates", script({ code: 'return "REQUESTER_CONSOLIDATE";' }),
              { label: "Merge PRs", updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), path: lit("REQUESTER_CONSOLIDATED"), humanComment: lit("Requester chose to consolidate") } }) },
          { value: "Explain", body: (e) => e
            .step("keepJustification", script({ code: "return String($vars.requesterTask.output.justification || '');", returns: "string" }),
              { label: "Save answer", updates: { justification: out("keepJustification") } })
            .step("rejudge", inlineAgent({
              model: MODEL, temperature: 0,
              systemPrompt: SYSTEM_PROMPT,
              userPrompt: "Case data:\n{{input.caseData}}\n\nRequester justification:\n{{input.justification}}",
              inputs: { caseData: out("rules", "agentInput"), justification: v("justification") },
              returns: AGENT_RETURNS,
            }), { label: "Agent re-judge" })
            .onError((h) => h.stepToRef("check3"))
            .step("check3", script({ code: validateCode("rejudge", true), returns: "object" }),
              { label: "Re-validate", updates: { agentResult: out("check3") } })
            .step("gateway2", script({ code: gatewayCode(false), returns: { decision: "string", path: "string" } }),
              { label: "Final guardrail", updates: { path: out("gateway2", "path"), needsReview: js`$vars.gateway2.output.decision !== 'RELEASE'` } }) },
        ], { label: "Requester task" }) },
    ], (rev) => rev.step("markReview", script({ code: 'return "REVIEW";' }),
      { label: "To review", updates: { needsReview: lit(true) } }),
    { label: "Agent outcome" }),
  { label: "Risk route" })

  // 8. Approver review, assigned for the combined amount.
  .branch("reviewNeeded", js`$vars.needsReview === true`,
    (yes) => yes.label("Yes")
    .step("reviewCard", script({ code: REVIEW_CARD_CODE, returns: { caseSummary: "string", ruleEvidence: "string", agentAssessment: "string", requesterJustification: "string", title: "string" } }),
      { label: "Review card" })
    .stepSwitch("approverReview", hitl({
      variant: "quick-form",
      title: out("reviewCard", "title"),
      priority: "High",
      labels: "SplitSentinel,Review",
      fields: reviewFields,
      outcomes: ["Consolidate", "Approve separately", "Reject", "False positive"],
    }), [
      { value: "Consolidate", body: (b) => b
        .step("decConsolidate", script({ code: 'return "CONSOLIDATE";' }),
          { label: "Consolidate", updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), humanComment: out("approverReview", "comment") } }) },
      { value: "Approve separately", body: (b) => b
        .step("decApproveSeparate", script({ code: 'return "APPROVE_SEPARATE";' }),
          { label: "Approve", updates: { finalPrStatus: lit("Released"), humanDecision: lit("APPROVE_SEPARATE"), humanComment: out("approverReview", "comment") } }) },
      { value: "Reject", body: (b) => b
        .step("decReject", script({ code: 'return "REJECT";' }),
          { label: "Reject", updates: { finalPrStatus: lit("Rejected"), humanDecision: lit("REJECT"), humanComment: out("approverReview", "comment") } }) },
      { value: "False positive", body: (b) => b
        .step("decFalsePositive", script({ code: 'return "FALSE_POSITIVE";' }),
          { label: "False positive", updates: { finalPrStatus: lit("Released"), humanDecision: lit("FALSE_POSITIVE"), humanComment: out("approverReview", "comment") } }) },
    ], { label: "Approver task" }),
    undefined, { label: "Review?" })

  // 9. Apply the outcome and write the audit record.
  .step("finalize", script({ code: FINALIZE_CODE, returns: "object" }), { label: "Prepare outcome" })
  .loop("applyStatus", out("finalize", "targetRecordIds"), (body) => body
    .step("setStatus", dataFabricUpdate({
      entity: "PurchaseRequisition",
      record: { byId: js`$vars.applyStatus.currentItem` },
      set: { status: v("finalPrStatus"), splitCaseId: out("finalize", "caseId") },
    }), { label: "Set status" }),
    { label: "Each PR" })
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
  }), { label: "Audit record" })

  // 10. Notify the requester (saved as a Gmail draft). Skipped on what-if runs; a failure is logged, never blocking.
  .branch("notifyNeeded", js`!$vars.dryRun && !!$vars.rules.output.requesterEmail`,
    (yes) => yes.label("Yes")
      .step("notifyText", script({ code: NOTIFY_CODE, returns: { to: "string", cc: "string", subject: "string", body: "string" } }),
        { label: "Compose" })
      .step("notify", connector(SendEmail, {
        To: out("notifyText", "to"),
        CC: out("notifyText", "cc"),
        Subject: out("notifyText", "subject"),
        Body: out("notifyText", "body"),
        SaveAsDraft: true,
      }, { connection: "gmail", folder: "shared" }), { label: "Gmail draft" })
      .onError((h) => h.stepToRef("notifyDone"))
      .step("notifyDone", script({ code: "return 'notified';" }), { label: "Done" }),
    undefined, { label: "Notify?" })
  .return({
    caseId: out("finalize", "caseId"), outcome: v("finalPrStatus"), path: v("path"),
    ruleScore: out("rules", "score"), agentVerdict: out("finalize", "agentVerdict"), humanDecision: v("humanDecision"),
  })
  .build();
