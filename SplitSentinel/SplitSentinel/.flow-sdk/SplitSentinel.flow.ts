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

// Display helpers shared by the form scripts. The Flow script runtime has no Intl,
// so Indian digit grouping (₹5,20,000) and short dates are done by hand.
const FORMAT_FNS = `
function inr(n) {
  var s = String(Math.round(Number(n) || 0)), last3 = s.slice(-3), rest = s.slice(0, -3);
  return '₹' + (rest ? rest.replace(/\\B(?=(\\d{2})+(?!\\d))/g, ',') + ',' : '') + last3;
}
function shortDate(iso) {
  var m = String(iso || '').match(/^(\\d{4})-(\\d{2})-(\\d{2})/);
  if (!m) return String(iso || '');
  return Number(m[3]) + ' ' + ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m[2]) - 1] + ' ' + m[1];
}
function roleName(r) {
  return { LineManager: 'Line Manager', DeptHead: 'Department Head', CFO: 'CFO', CFOCommittee: 'CFO + Procurement Committee' }[r] || r || 'approver';
}
function listIds(ids) {
  ids = ids || [];
  return ids.length < 2 ? ids.join('') : ids.slice(0, -1).join(', ') + ' and ' + ids[ids.length - 1];
}
`;

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
var recordIds = {}, amounts = {}, statuses = {}, caseLinks = {};
group.forEach(function (p) {
  recordIds[p.prId] = p.id; amounts[p.prId] = Number(p.amount);
  statuses[p.prId] = p.status || ''; caseLinks[p.prId] = p.splitCaseId || '';
});
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
${FORMAT_FNS}
var summary = group.slice().sort(function (x, y) { return Date.parse(x.createdAt) - Date.parse(y.createdAt); }).map(function (p) {
  var vn = (vendors.filter(function (x) { return x.vendorId === p.vendorId; })[0] || {}).name || p.vendorId;
  return '• ' + p.prId + (p.prId === prId ? ' (this PR)' : '') + '  ·  ' + shortDate(p.createdAt) + '  ·  ' + vn + '\\n   '
    + p.description + '  ·  ' + inr(p.amount);
}).join('\\n');
// Structured rows for the review app's PR table.
var groupRows = group.slice().sort(function (x, y) { return Date.parse(x.createdAt) - Date.parse(y.createdAt); }).map(function (p) {
  var vn = (vendors.filter(function (x) { return x.vendorId === p.vendorId; })[0] || {}).name || p.vendorId;
  return { prId: p.prId, date: shortDate(p.createdAt), vendor: vn, description: p.description, amount: Number(p.amount), isAnchor: p.prId === prId };
});
return {
  groupRows: groupRows,
  route: r.route, score: r.score, patterns: r.patterns.join(','), signals: JSON.stringify(r.signals),
  groupPrIds: r.groupPrIds, knownPrIds: r.groupPrIds, recordIds: recordIds, amounts: amounts,
  statuses: statuses, caseLinks: caseLinks,
  anchorRecordId: anchor.id, combinedAmount: r.combinedAmount, combinedTier: r.combinedTier, anchorTier: r.anchorTier,
  requesterName: requester.name || anchor.requesterId, requesterCostCenter: requester.costCenter || anchor.costCenter,
  requesterEmail: requester.email || '',
  managerEmail: manager.email || '', agentInput: JSON.stringify(agentInput), summary: summary,
  matrix: agentInput.approvalMatrix
};
`;

const RULES_RETURNS = {
  route: "string", score: "number", patterns: "string", signals: "string",
  groupPrIds: "array", knownPrIds: "array", recordIds: "object", amounts: "object",
  groupRows: "array", statuses: "object", caseLinks: "object",
  anchorRecordId: "string", combinedAmount: "number", combinedTier: "string", anchorTier: "string",
  requesterName: "string", requesterCostCenter: "string", requesterEmail: "string", managerEmail: "string",
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
var groupWide = st === 'Consolidated' || st === 'Rejected';
var statuses = rules.statuses || {}, caseLinks = rules.caseLinks || {};
// Consolidate / Reject apply to the whole group. Otherwise only this PR changes status; the
// other PRs judged with it keep their status and are linked to this case unless already linked.
var targets = $vars.dryRun ? [] : related.filter(function (x) {
  return groupWide || x === $vars.prId || ($vars.humanDecision && !caseLinks[x]);
}).map(function (x) {
  return { prId: x, id: rules.recordIds[x], status: (groupWide || x === $vars.prId) ? st : (statuses[x] || st) };
}).filter(function (t) { return t.id; });
var log = ['rules: score ' + rules.score + ' [' + rules.patterns + '] route ' + rules.route];
if ($vars.requesterAnswer) {
  log.push('agent: ' + ($vars.firstVerdict || 'NOT_RUN') + ' -> asked the requester');
  log.push('requester: ' + $vars.requesterAnswer + ($vars.justification ? ' (explanation given)' : ''));
  if ($vars.justification) log.push('agent re-judge: ' + (a.verdict || 'NOT_RUN') + (a.corrections ? ' (corrected: ' + a.corrections + ')' : ''));
} else {
  log.push('agent: ' + (a.verdict || 'NOT_RUN') + (a.corrections ? ' (corrected: ' + a.corrections + ')' : ''));
}
log.push('path: ' + $vars.path);
log.push('human: ' + ($vars.humanDecision || 'none') + ($vars.decidedBy ? ' by ' + $vars.decidedBy : ''));
log.push('final: ' + st + ' -> ' + ($vars.dryRun ? 'what-if run, no PR updated'
  : targets.map(function (t) { return t.prId + (t.status === st ? '' : ' (linked, stays ' + t.status + ')'); }).join(',')));
var runLog = log.join('\\n');
return {
  caseId: ($vars.dryRun ? 'WHATIF-' + $vars.prId + '-' + Date.now() : 'SC-' + $vars.prId),
  targets: targets.map(function (t) { return { id: t.id, status: t.status }; }),
  relatedPrIds: related.join(','),
  agentVerdict: a.verdict || 'NOT_RUN',
  runLog: runLog
};
`;

// Form text is computed in a script step: human-task fields bind to variable paths only.
const REVIEW_CARD_CODE = `
${FORMAT_FNS}
var a = $vars.agentResult || {};
var rules = $vars.rules.output;
var amount = a.combinedAmount || rules.combinedAmount;
var tier = a.requiredApprovalTier || rules.combinedTier;
var tierRow = (rules.matrix || []).filter(function (t) { return t.tierId === tier; })[0] || {};
var anchorRow = (rules.matrix || []).filter(function (t) { return t.tierId === rules.anchorTier; })[0] || {};
// RFQ comes from the approval matrix, never from the agent's answer.
var rfq = tierRow.rfqRequired === true || String(tierRow.rfqRequired) === 'true';
var related = (a.relatedPrIds && a.relatedPrIds.length ? a.relatedPrIds : rules.groupPrIds);
var others = related.filter(function (x) { return x !== $vars.prId; });
var approval = tier + ' · ' + roleName(tierRow.approverRole) + (rfq ? ' + RFQ' : '');
var signals = JSON.parse(rules.signals || '[]');
// The signals score the rules' group; say so when the agent narrowed or changed it.
var ruleGroup = rules.groupPrIds || [];
var sameGroup = ruleGroup.length === related.length && ruleGroup.every(function (x) { return related.indexOf(x) >= 0; });
var ruleGroupNote = sameGroup ? '' : 'These signals score the group the rules looked at: ' + listIds(ruleGroup)
  + ' (' + inr(rules.combinedAmount) + '). The AI judged ' + listIds(related) + ' to be the related purchase ('
  + inr(amount) + '), which is what the table above and the approval tier use.';
// Shaped to the review app's action-schema.json inputs (SplitSentinelReview).
return {
  prId: $vars.prId,
  caseRef: ($vars.dryRun ? 'What-if · ' : '') + 'SC-' + $vars.prId,
  requesterName: rules.requesterName,
  requesterCostCenter: rules.requesterCostCenter,
  whatHappened: rules.requesterName + ' raised ' + $vars.prId
    + (others.length ? '. Together with ' + listIds(others) + ' it comes to ' + inr(amount) : ' for ' + inr(amount))
    + ', which needs ' + roleName(tierRow.approverRole) + ' approval (' + tier + ')' + (rfq ? ' and a competitive bid (RFQ)' : '')
    + (rules.anchorTier && rules.anchorTier !== tier ? '. On its own, the PR only needed ' + roleName(anchorRow.approverRole) + ' approval (' + rules.anchorTier + ').' : '.'),
  combinedAmount: Number(amount) || 0,
  approvalTier: tier || '',
  approverRole: roleName(tierRow.approverRole),
  rfqRequired: rfq,
  anchorTier: rules.anchorTier || '',
  anchorApproverRole: roleName(anchorRow.approverRole),
  riskScore: Math.round(Number(rules.score) || 0),
  relatedPrs: (rules.groupRows || []).filter(function (row) { return related.indexOf(row.prId) >= 0; }),
  signals: signals.map(function (s) { return { text: s.detail, points: s.points }; }),
  ruleGroupNote: ruleGroupNote,
  aiVerdict: a.verdict || 'NOT_RUN',
  aiConfidence: Number(a.confidence) || 0,
  aiException: a.legitException || 'NONE',
  aiReasoning: a.reasoning || '',
  aiCorrections: a.corrections || '',
  requesterJustification: $vars.justification || '',
  title: 'Possible split: ' + $vars.prId + ' · ' + inr(amount) + ' needs ' + roleName(tierRow.approverRole)
};
`;

// Who decided: the app SDK exposes no user, so the case records the Action Center task id
// (Action Center keeps who completed it). Both apps return taskId as an output.
const APPROVER_DECIDED_BY = js`'Approver, Action Center task ' + ($vars.approverReview.output.taskId || '?')`;
const REQUESTER_DECIDED_BY = js`'Requester, Action Center task ' + ($vars.requesterTask.output.taskId || '?')`;

// The review app (coded Action App in this solution): its key and data contract are read
// from the solution files, so the Flow always matches the app that ships with it.
const REVIEW_APP = JSON.parse(repo("SplitSentinel/resources/solution_folder/app/codedAction/SplitSentinelReview.json")).resource;
const REVIEW_SCHEMA = JSON.parse(repo("SplitSentinel/SplitSentinelReview/action-schema.json"));
const REVIEW_CARD_RETURNS = {
  prId: "string", caseRef: "string", requesterName: "string", requesterCostCenter: "string", whatHappened: "string",
  combinedAmount: "number", approvalTier: "string", approverRole: "string", rfqRequired: "boolean",
  anchorTier: "string", anchorApproverRole: "string", riskScore: "number", relatedPrs: "array", signals: "array",
  ruleGroupNote: "string", aiVerdict: "string", aiConfidence: "number", aiException: "string", aiReasoning: "string", aiCorrections: "string",
  requesterJustification: "string", title: "string",
} as const;
// Every app input is bound to the review card's field of the same name.
const REVIEW_APP_INPUTS = Object.fromEntries(
  Object.keys(REVIEW_SCHEMA.inputs.properties).map((k) => [k, out("reviewCard", k)]),
);

const ASK_CARD_CODE = `
${FORMAT_FNS}
var a = $vars.agentResult || {};
var rules = $vars.rules.output;
var tierRow = (rules.matrix || []).filter(function (t) { return t.tierId === a.requiredApprovalTier; })[0] || {};
var first = String(rules.requesterName || '').split(' ')[0] || 'there';
var related = a.relatedPrIds && a.relatedPrIds.length ? a.relatedPrIds : rules.groupPrIds;
// Shaped to the explain app's action-schema.json inputs (SplitSentinelExplain).
return {
  prId: $vars.prId,
  caseRef: ($vars.dryRun ? 'What-if · ' : '') + 'SC-' + $vars.prId,
  requesterName: first,
  message: 'Hi ' + first + ', your requisitions ' + listIds(related) + ' look like parts of one purchase. '
    + 'Together they come to ' + inr(a.combinedAmount) + ', which needs ' + roleName(tierRow.approverRole) + ' approval ('
    + a.requiredApprovalTier + '). If they really are separate needs, tell us why; otherwise merge them.',
  combinedAmount: Number(a.combinedAmount) || 0,
  approvalTier: a.requiredApprovalTier || '',
  approverRole: roleName(tierRow.approverRole),
  rfqRequired: tierRow.rfqRequired === true || String(tierRow.rfqRequired) === 'true',
  relatedPrs: (rules.groupRows || []).filter(function (row) { return related.indexOf(row.prId) >= 0; }),
  title: 'Please explain: ' + $vars.prId + ' may be a split purchase'
};
`;

const EXPLAIN_APP = JSON.parse(repo("SplitSentinel/resources/solution_folder/app/codedAction/SplitSentinelExplain.json")).resource;
const EXPLAIN_SCHEMA = JSON.parse(repo("SplitSentinel/SplitSentinelExplain/action-schema.json"));
const ASK_CARD_RETURNS = {
  prId: "string", caseRef: "string", requesterName: "string", message: "string", combinedAmount: "number",
  approvalTier: "string", approverRole: "string", rfqRequired: "boolean", relatedPrs: "array", title: "string",
} as const;
const EXPLAIN_APP_INPUTS = Object.fromEntries(
  Object.keys(EXPLAIN_SCHEMA.inputs.properties).map((k) => [k, out("askCard", k)]),
);

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

// The review app's outcome keys (its buttons show friendly labels and tooltips).
const REVIEW_OUTCOMES = { consolidate: "MergePRs", separate: "KeepSeparate", reject: "Reject", notSplit: "NotASplit" };
// The explain app's outcome keys.
const ASK_OUTCOMES = { explain: "SubmitExplanation", merge: "MergeMyPRs" };

// Canvas annotations. Sticky notes are inert: the platform skips them during validation
// and conversion, so they document the diagram without changing behaviour.
const NOTES = [
  { id: "noteEntry", color: "green", x: -16, y: 416, width: 380, height: 198,
    content: "TWO WAYS IN\n• Automatic: a new PurchaseRequisition record in Data Fabric starts the run.\n• Manual: pass requisitionId (and whatIf=true to re-check without changing anything)." },
  { id: "noteIdempotency", color: "white", x: 768, y: 288, width: 300, height: 150,
    content: "ONE CASE PER PR\nIf a SplitCase already exists for this PR, the run stops (duplicate trigger).\nWhat-if runs skip this check and write WHATIF-… audit rows instead." },
  { id: "noteFailClosed", color: "pink", x: 2288, y: 496, width: 394, height: 160,
    content: "FAIL CLOSED\nData Fabric reads have no error port: a failed read faults the run, so nothing is ever auto-released.\nMissing reference data (tiers, employees, vendors) holds the PR as Unverified." },
  { id: "noteRules", color: "blue", x: 2816, y: -288, width: 388, height: 186,
    content: "RULE ENGINE (rules/score.js, inlined at compile time)\nGroups related PRs from the last 30 days and scores 0–100.\n0–29: release, no agent call\n30–59: agent decides\n60–100: agent + mandatory human review" },
  { id: "noteAgent", color: "blue", x: 3488, y: 352, width: 442, height: 176,
    content: "AGENT + VALIDATION\nClaude Sonnet 4.6 judges whether the PRs are one need, grounded in the procurement policy.\nEvery answer is checked against the data (PR ids, amount, tier). Invalid → one retry → FAILED → human." },
  { id: "noteGuardrail", color: "pink", x: 3984, y: 352, width: 330, height: 176,
    content: "GUARDRAIL\nThe agent can clear a case only with a legitimate exception AND a rule score below 60.\nEverything else goes to a person — the agent never approves a high-risk case on its own." },
  { id: "noteRequester", color: "yellow", x: 4976, y: 544, width: 496, height: 166,
    content: "REQUESTER EXPLANATION (coded Action App SplitSentinelExplain, one round)\nOn mixed evidence the requester sees their PRs as a table and can explain or merge.\nThe agent re-judges with the explanation; vague reasons (\"urgent\") don't count." },
  { id: "noteApprover", color: "yellow", x: 6880, y: 48, width: 340, height: 170,
    content: "APPROVER REVIEW (coded Action App SplitSentinelReview)\nPR and signal tables, AI verdict, tooltips on every button. The chosen button comes back as Action; unknown values are held.\nSLA/escalation is set in Action Center." },
  { id: "noteAudit", color: "white", x: 8480, y: -16, width: 320, height: 150,
    content: "AUDIT TRAIL\nEvery run writes a SplitCase record: rule score + signals, agent verdict + reasoning, human decision, final outcome and a step-by-step run log." },
  { id: "noteNotify", color: "green", x: 8944, y: -16, width: 400, height: 150,
    content: "NOTIFICATIONS\nThe requester (and manager, on consolidate/reject) gets an email saved as a Gmail draft.\nSkipped on what-if runs; a mail failure never blocks the case." },
];

// Canvas layout, arranged in the Studio Web designer and copied here (2026-11-15).
// Do not run `uip maestro flow format` after compile: it would replace this layout.
const LAYOUT = {
  nodes: {
    start: at(0, 0), resolveRun: at(576, 128), existingCase: at(768, 128), alreadyChecked: at(960, 128),
    end: at(1152, -48), loadPrs: at(1152, 144), loadEmployees: at(1344, 144), loadVendors: at(1536, 144),
    loadMatrix: at(1728, 144), loadBlankets: at(1920, 144), rules: at(2112, 144), end2: at(2336, 352),
    route: at(2320, -144, dim(96, 192)), end3: at(2656, -384), end4: at(2656, -240), ruleRelease: at(2656, -96),
    holdUnverified: at(2656, 48), judge: at(2656, 192), check1: at(3040, 192), retryNeeded: at(3312, 192),
    judgeRetry: at(3536, 80), check2: at(3888, 80), gateway: at(4112, 208), decision: at(4384, 192, dim(96, 128)),
    agentRelease: at(4768, -32), askCard: at(4768, 208), requesterTask: at(4992, 208), requesterDecision: at(5248, 176, dim(96, 128)),
    requesterConsolidates: at(5488, 48), keepJustification: at(5488, 192), rejudge: at(5648, 192), check3: at(6032, 192),
    gateway2: at(6224, 192), requesterUnknown: at(5488, 336), markReview: at(4768, 448), reviewNeeded: at(6512, 192),
    reviewCard: at(6800, -160), approverReview: at(6976, -192, dim(96, 160)), approverDecision: at(7200, -208, dim(96, 192)), decConsolidate: at(7472, -416),
    decApproveSeparate: at(7472, -272), decReject: at(7472, -160), decFalsePositive: at(7472, -32), decUnknown: at(7472, 112),
    finalize: at(7696, -160), applyStatus: at(7872, -272, dim(560, 320)), setStatus: at(240, 112), writeCase: at(8512, -160),
    notifyNeeded: at(8672, -160), notifyText: at(8912, -256), notify: at(9072, -256), notifyDone: at(9264, -256),
    end5: at(9424, -144), onPrCreated: at(0, 256), createdPr: at(192, 256), fromEvent: at(384, 128),
  },
  edges: {
    "alreadyChecked->end": { routedWaypoints: [{ x: 1104, y: 160 }, { x: 1104, y: 0 }] },
    "rules->end2": { waypoints: [{ x: 2272, y: 208 }, { x: 2272, y: 400 }] },
    "route->end3": { waypoints: [{ x: 2480, y: -112 }, { x: 2480, y: -336 }] },
    "route->end4": { waypoints: [{ x: 2576, y: -80 }, { x: 2576, y: -192 }] },
    "route->holdUnverified": { waypoints: [{ x: 2576, y: -16 }, { x: 2576, y: 96 }] },
    "route->judge": { waypoints: [{ x: 2480, y: 16 }, { x: 2480, y: 240 }] },
    "check2->gateway": { waypoints: [{ x: 4064, y: 128 }, { x: 4064, y: 256 }] },
    "ruleRelease->reviewNeeded": { waypoints: [{ x: 6416, y: -48 }, { x: 6416, y: 240 }] },
    "holdUnverified->reviewNeeded": { waypoints: [{ x: 3376, y: 96 }, { x: 3376, y: -48 }, { x: 6416, y: -48 }, { x: 6416, y: 240 }] },
    "agentRelease->reviewNeeded": { waypoints: [{ x: 6416, y: 16 }, { x: 6416, y: 240 }] },
    "requesterConsolidates->reviewNeeded": { waypoints: [{ x: 6416, y: 96 }, { x: 6416, y: 240 }] },
    "requesterUnknown->reviewNeeded": { waypoints: [{ x: 6416, y: 384 }, { x: 6416, y: 240 }] },
    "markReview->reviewNeeded": { waypoints: [{ x: 5296, y: 496 }, { x: 5296, y: 496 }, { x: 6416, y: 496 }, { x: 6416, y: 240 }] },
    "approverReview->approverDecision": { waypoints: [{ x: 7184, y: -160 }, { x: 7216, y: -112 }] },
    "approverDecision->decApproveSeparate": { waypoints: [{ x: 7424, y: -144 }, { x: 7424, y: -224 }] },
    "approverDecision->decReject": { waypoints: [{ x: 7424, y: -112 }, { x: 7424, y: -112 }] },
    "approverDecision->decFalsePositive": { waypoints: [{ x: 7424, y: -80 }, { x: 7424, y: 16 }] },
    "reviewNeeded->finalize": { waypoints: [{ x: 7632, y: 256 }, { x: 7632, y: -112 }] },
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
  // Who decided: the Action Center task id (the app SDK exposes no user; the task records who completed it).
  .var("decidedBy", types.string, "")
  .var("firstVerdict", types.string, "")
  .var("requesterAnswer", types.string, "")
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
      { label: "Guardrail", updates: { path: out("gateway", "path"), firstVerdict: js`($vars.agentResult || {}).verdict || ''` } })
    .switch("decision", out("gateway", "decision"), [
      { value: "RELEASE", label: "Cleared",
        body: (b) => b.step("agentRelease", script({ code: 'return "AGENT_RELEASE";' }),
          { label: "Agent cleared", updates: { finalPrStatus: lit("Released") } }) },
      { value: "ASK_REQUESTER", label: "Ask requester", body: (b) => b
        // 7. Requester justification, then one re-evaluation (no second ask).
        .step("askCard", script({ code: ASK_CARD_CODE, returns: ASK_CARD_RETURNS }), { label: "Draft question" })
        // Coded Action App: the requester's PRs as a table, tooltips on both buttons.
        .step("requesterTask", hitl({
          variant: "action-app",
          title: out("askCard", "title"),
          priority: "Medium",
          labels: "SplitSentinel,Justification",
          app: {
            name: EXPLAIN_APP.name,
            key: EXPLAIN_APP.key,
            location: "in-solution",
            actionSchema: EXPLAIN_SCHEMA,
            inputs: EXPLAIN_APP_INPUTS,
          },
          outcomes: [ASK_OUTCOMES.explain, ASK_OUTCOMES.merge],
        }), { label: "Requester task" })
        .switch("requesterDecision", out("requesterTask", "Action"), [
          { value: ASK_OUTCOMES.merge, label: "Merge my PRs", body: (c) => c
            .step("requesterConsolidates", script({ code: 'return "REQUESTER_CONSOLIDATE";' }),
              { label: "Merge PRs", updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), path: lit("REQUESTER_CONSOLIDATED"), humanComment: lit("Requester chose to consolidate"),
                requesterAnswer: lit(ASK_OUTCOMES.merge), decidedBy: REQUESTER_DECIDED_BY } }) },
          { value: ASK_OUTCOMES.explain, label: "Explained", body: (e) => e
            .step("keepJustification", script({ code: "return String($vars.requesterTask.output.justification || '');", returns: "string" }),
              { label: "Save answer", updates: { justification: out("keepJustification"), requesterAnswer: lit(ASK_OUTCOMES.explain) } })
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
        ], (other) => other
          // Fail closed: an answer the Flow doesn't know goes to the approver.
          .step("requesterUnknown", script({ code: "return String($vars.requesterTask.output.Action || '');", returns: "string" }),
            { label: "Unknown: review", updates: { needsReview: lit(true), path: lit("REQUESTER_UNKNOWN"), requesterAnswer: js`'unknown answer ' + ($vars.requesterTask.output.Action || '')` } }),
        { label: "Requester answer" }) },
    ], (rev) => rev.step("markReview", script({ code: 'return "REVIEW";' }),
      { label: "To review", updates: { needsReview: lit(true) } }),
    { label: "Agent outcome" }),
  { label: "Risk route" })

  // 8. Approver review, assigned for the combined amount.
  .branch("reviewNeeded", js`$vars.needsReview === true`,
    (yes) => yes.label("Yes")
    .step("reviewCard", script({ code: REVIEW_CARD_CODE, returns: REVIEW_CARD_RETURNS }), { label: "Review card" })
    // Coded Action App: tables for the PRs and rule signals, tooltips on every button.
    .step("approverReview", hitl({
      variant: "action-app",
      title: out("reviewCard", "title"),
      priority: "High",
      labels: "SplitSentinel,Review",
      app: {
        name: REVIEW_APP.name,
        key: REVIEW_APP.key,
        location: "in-solution",
        actionSchema: REVIEW_SCHEMA,
        inputs: REVIEW_APP_INPUTS,
      },
      outcomes: [REVIEW_OUTCOMES.consolidate, REVIEW_OUTCOMES.separate, REVIEW_OUTCOMES.reject, REVIEW_OUTCOMES.notSplit],
    }), { label: "Approver task" })
    // An app task leaves on one exit; the chosen button arrives as `Action`.
    .switch("approverDecision", out("approverReview", "Action"), [
      { value: REVIEW_OUTCOMES.consolidate, label: "Merge PRs", body: (b) => b
        .step("decConsolidate", script({ code: 'return "CONSOLIDATE";' }),
          { label: "Consolidate", updates: { finalPrStatus: lit("Consolidated"), humanDecision: lit("CONSOLIDATE"), humanComment: out("approverReview", "comment"), decidedBy: APPROVER_DECIDED_BY } }) },
      { value: REVIEW_OUTCOMES.separate, label: "Keep separate", body: (b) => b
        .step("decApproveSeparate", script({ code: 'return "APPROVE_SEPARATE";' }),
          { label: "Approve", updates: { finalPrStatus: lit("Released"), humanDecision: lit("APPROVE_SEPARATE"), humanComment: out("approverReview", "comment"), decidedBy: APPROVER_DECIDED_BY } }) },
      { value: REVIEW_OUTCOMES.reject, label: "Reject", body: (b) => b
        .step("decReject", script({ code: 'return "REJECT";' }),
          { label: "Reject", updates: { finalPrStatus: lit("Rejected"), humanDecision: lit("REJECT"), humanComment: out("approverReview", "comment"), decidedBy: APPROVER_DECIDED_BY } }) },
      { value: REVIEW_OUTCOMES.notSplit, label: "Not a split", body: (b) => b
        .step("decFalsePositive", script({ code: 'return "FALSE_POSITIVE";' }),
          { label: "False positive", updates: { finalPrStatus: lit("Released"), humanDecision: lit("FALSE_POSITIVE"), humanComment: out("approverReview", "comment"), decidedBy: APPROVER_DECIDED_BY } }) },
    ], (other) => other
      // Fail closed: an outcome the Flow doesn't know never releases anything.
      .step("decUnknown", script({ code: "return String($vars.approverReview.output.Action || '');", returns: "string" }),
        { label: "Unknown: hold", updates: { finalPrStatus: lit("OnHold"), humanDecision: lit("UNKNOWN"), humanComment: out("approverReview", "comment"), decidedBy: APPROVER_DECIDED_BY } }),
    { label: "Decision" }),
    undefined, { label: "Review?" })

  // 9. Apply the outcome and write the audit record.
  .step("finalize", script({ code: FINALIZE_CODE, returns: "object" }), { label: "Prepare outcome" })
  .loop("applyStatus", out("finalize", "targets"), (body) => body
    .step("setStatus", dataFabricUpdate({
      entity: "PurchaseRequisition",
      record: { byId: js`$vars.applyStatus.currentItem.id` },
      set: { status: js`$vars.applyStatus.currentItem.status`, splitCaseId: out("finalize", "caseId") },
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
      decidedBy: v("decidedBy"),
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
