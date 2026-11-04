// Offline evaluation of the rule layer against the labelled eval set.
// Usage: node agent/evals/run-rule-evals.js
// Checks, for every seed-backed case, that the rule engine routes the anchor PR as labelled
// (release without the agent vs. send to the agent) and, where labelled, groups the right PRs.
// Agent verdicts need cloud runs; see docs/evaluation-results.md.

const path = require('path');
const { scorePrs } = require('../../rules/score.js');

const seed = (n) => require(path.join(__dirname, '../../data/seed', n + '.json'));
const prs = seed('purchase_requisitions');
const employees = seed('employees');
const vendors = seed('vendors');
const matrix = seed('approval_matrix');
const blanketPos = seed('blanket_pos');
const { cases } = require('./eval-set.json');

let pass = 0, fail = 0, skipped = 0;
const rows = [];
for (const c of cases) {
  if (c.simulate || c.requesterJustification) { skipped++; rows.push([c.id, c.scenario, 'needs Flow run', '-']); continue; }
  const anchor = prs.find((p) => p.prId === c.anchorPrId);
  const r = scorePrs(anchor, prs, {
    approvalMatrix: matrix,
    requester: employees.find((e) => e.employeeId === anchor.requesterId),
    vendor: vendors.find((v) => v.vendorId === anchor.vendorId),
    blanketPos,
  });
  const problems = [];
  const agentCalled = r.route !== 'RELEASE';
  if (c.expect.route && c.expect.route !== r.route) problems.push(`route ${r.route} != ${c.expect.route}`);
  if (c.expect.agentCalled !== undefined && c.expect.agentCalled !== agentCalled) problems.push(`agentCalled ${agentCalled}`);
  if (c.expect.relatedPrIds && [...c.expect.relatedPrIds].sort().join() !== [...r.groupPrIds].sort().join()) {
    problems.push(`group ${r.groupPrIds.join(',')}`);
  }
  if (c.expect.requiredApprovalTier && c.expect.requiredApprovalTier !== r.combinedTier) problems.push(`tier ${r.combinedTier}`);
  if (problems.length) fail++; else pass++;
  rows.push([c.id, c.scenario, `score ${r.score} ${r.route} [${r.patterns.join(',')}]`, problems.length ? 'FAIL: ' + problems.join('; ') : 'PASS']);
}

const w = [5, 18, 48];
for (const row of rows) console.log(row.map((x, i) => (i < 3 ? String(x).padEnd(w[i]) : x)).join(' '));
console.log(`\nrule-layer cases: ${pass} pass, ${fail} fail, ${skipped} need a Flow run`);
process.exitCode = fail ? 1 : 0;
