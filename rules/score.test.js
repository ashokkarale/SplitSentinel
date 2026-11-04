const test = require('node:test');
const assert = require('node:assert/strict');
const { scorePrs, tierFor, jaccard } = require('./score.js');

const MATRIX = [
  { tierId: 'T1', minAmount: 0, maxAmount: 100000, approverRole: 'LineManager' },
  { tierId: 'T2', minAmount: 100000, maxAmount: 500000, approverRole: 'DeptHead' },
  { tierId: 'T3', minAmount: 500000, maxAmount: 2500000, approverRole: 'CFO' },
  { tierId: 'T4', minAmount: 2500000, maxAmount: null, approverRole: 'CFO+Committee' },
];
const REQUESTER = { employeeId: 'E001', approvalLimit: 150000 };
const VENDOR = { vendorId: 'V001', name: 'Acme IT', isRecurring: false };
const BASE = '2026-11-10T10:00:00Z';

function at(offsetHours) {
  return new Date(Date.parse(BASE) + offsetHours * 3600000).toISOString();
}

function pr(id, overrides) {
  return Object.assign({
    prId: id, requesterId: 'E001', costCenter: 'CC-IT', projectCode: null, vendorId: 'V001',
    category: 'IT Hardware', description: 'Laptop 14 inch i7 16GB', quantity: 1, unitPrice: 95000,
    amount: 95000, currency: 'INR', blanketPoRef: null, isEmergency: false, createdAt: BASE, status: 'Submitted',
  }, overrides);
}

function ctx(extra) {
  return Object.assign({ approvalMatrix: MATRIX, requester: REQUESTER, vendor: VENDOR, blanketPos: [] }, extra);
}

test('tierFor: boundaries are min-inclusive, max-exclusive', () => {
  assert.equal(tierFor(99999, MATRIX).tier.tierId, 'T1');
  assert.equal(tierFor(100000, MATRIX).tier.tierId, 'T2');
  assert.equal(tierFor(499999, MATRIX).tier.tierId, 'T2');
  assert.equal(tierFor(500000, MATRIX).tier.tierId, 'T3');
  assert.equal(tierFor(90000000, MATRIX).tier.tierId, 'T4');
});

test('no history: score 0, release, group is the anchor alone', () => {
  const r = scorePrs(pr('PR-1'), [], ctx());
  assert.equal(r.score, 0);
  assert.equal(r.route, 'RELEASE');
  assert.deepEqual(r.groupPrIds, ['PR-1']);
  assert.deepEqual(r.patterns, []);
});

test('classic split: 3 x 95k same requester/vendor within 3 days', () => {
  const anchor = pr('PR-3', { createdAt: at(48) });
  const r = scorePrs(anchor, [pr('PR-1'), pr('PR-2', { createdAt: at(24) })], ctx());
  assert.equal(r.combinedAmount, 285000);
  assert.equal(r.anchorTier, 'T1');
  assert.equal(r.combinedTier, 'T2');
  assert.ok(r.crossesTier);
  for (const p of ['P1', 'TIER', 'P2', 'P6', 'P3']) assert.ok(r.patterns.includes(p), p);
  assert.equal(r.score, 80);
  assert.equal(r.route, 'AGENT_HUMAN_REQUIRED');
});

test('P2 edge: 84.9% of the ceiling does not fire, 85% does', () => {
  const lowCtx = ctx({ requester: { approvalLimit: 0 } });
  const r1 = scorePrs(pr('PR-2', { amount: 84900, createdAt: at(1) }), [pr('PR-1', { amount: 84900 })], lowCtx);
  assert.ok(!r1.patterns.includes('P2'));
  const r2 = scorePrs(pr('PR-2', { amount: 85000, createdAt: at(1) }), [pr('PR-1', { amount: 85000 })], lowCtx);
  assert.ok(r2.patterns.includes('P2'));
});

test('P6 edge: 72h exactly fires, 72h + 1 min does not', () => {
  const r1 = scorePrs(pr('PR-2', { createdAt: at(72) }), [pr('PR-1')], ctx());
  assert.ok(r1.patterns.includes('P6'));
  const r2 = scorePrs(pr('PR-2', { createdAt: at(72 + 1 / 60) }), [pr('PR-1')], ctx());
  assert.ok(!r2.patterns.includes('P6'));
});

test('lookback: a PR 31 days earlier is not grouped', () => {
  const r = scorePrs(pr('PR-2', { createdAt: at(31 * 24) }), [pr('PR-1')], ctx());
  assert.deepEqual(r.groupPrIds, ['PR-2']);
  assert.equal(r.score, 0);
});

test('later PRs, drafts and rejected PRs are ignored', () => {
  const r = scorePrs(pr('PR-2'), [
    pr('PR-3', { createdAt: at(5) }),
    pr('PR-4', { status: 'Draft', createdAt: at(-5) }),
    pr('PR-5', { status: 'Rejected', createdAt: at(-5) }),
  ], ctx());
  assert.deepEqual(r.groupPrIds, ['PR-2']);
});

test('P5 collusion: different requester, same vendor and cost centre', () => {
  const anchor = pr('PR-2', { requesterId: 'E002', amount: 260000, description: 'Diwali campaign print flyers', createdAt: at(2) });
  const r = scorePrs(anchor, [pr('PR-1', { amount: 260000, description: 'Diwali campaign print flyers' })], ctx());
  assert.ok(r.patterns.includes('P5'));
  assert.ok(!r.patterns.includes('P1'));
  assert.equal(r.combinedTier, 'T3');
  assert.ok(r.patterns.includes('TIER'));
});

test('same project, different vendors: low-medium score that still reaches the agent', () => {
  const base = { projectCode: 'APOLLO', category: 'IT Hardware' };
  const anchor = pr('PR-3', Object.assign({}, base, { vendorId: 'V003', description: 'USB-C docking station', amount: 60000, createdAt: at(6 * 24) }));
  const r = scorePrs(anchor, [
    pr('PR-1', Object.assign({}, base, { vendorId: 'V001', description: 'Laptop 14 inch i7 16GB', amount: 95000 })),
    pr('PR-2', Object.assign({}, base, { vendorId: 'V002', description: '65W USB-C charger', amount: 40000, createdAt: at(3 * 24) })),
  ], ctx({ vendor: { vendorId: 'V003', isRecurring: false } }));
  assert.ok(r.patterns.includes('PROJ'));
  assert.ok(r.patterns.includes('TIER'));
  assert.ok(!r.patterns.includes('P1'));
  assert.equal(r.score, 30);
  assert.equal(r.route, 'AGENT');
});

test('recurring vendor deduction', () => {
  const anchor = pr('PR-2', { amount: 40000, description: 'Monthly stationery', createdAt: at(20 * 24) });
  const r = scorePrs(anchor, [pr('PR-1', { amount: 35000, description: 'Monthly stationery' })],
    ctx({ vendor: { vendorId: 'V001', isRecurring: true } }));
  assert.ok(r.signals.some((s) => s.code === 'X_RECURRING' && s.points === -20));
  assert.equal(r.route, 'RELEASE');
});

test('blanket PO deduction only when the blanket PO is valid', () => {
  const bpo = [{ blanketPoId: 'BPO-001', vendorId: 'V001', validFrom: '2026-10-01', validTo: '2026-12-31' }];
  const prs = [pr('PR-1', { amount: 80000, blanketPoRef: 'BPO-001' }), pr('PR-2', { amount: 80000, blanketPoRef: 'BPO-001', createdAt: at(24) })];
  const anchor = pr('PR-3', { amount: 80000, blanketPoRef: 'BPO-001', createdAt: at(48) });
  const ok = scorePrs(anchor, prs, ctx({ blanketPos: bpo }));
  assert.ok(ok.patterns.length > 0);
  assert.ok(ok.signals.some((s) => s.code === 'X_BLANKET'));
  const expired = scorePrs(anchor, prs, ctx({ blanketPos: [Object.assign({}, bpo[0], { validTo: '2026-10-31' })] }));
  assert.ok(!expired.signals.some((s) => s.code === 'X_BLANKET'));
});

test('emergency deduction requires every PR flagged', () => {
  const anchor = pr('PR-2', { isEmergency: true, createdAt: at(5) });
  const all = scorePrs(anchor, [pr('PR-1', { isEmergency: true })], ctx());
  assert.ok(all.signals.some((s) => s.code === 'X_EMERGENCY'));
  const some = scorePrs(anchor, [pr('PR-1', { isEmergency: false })], ctx());
  assert.ok(!some.signals.some((s) => s.code === 'X_EMERGENCY'));
});

test('P7 habit: 3+ near-threshold PRs by the requester in 90 days', () => {
  const history = [-80, -60, -40].map((d, i) => pr('PR-H' + i, { vendorId: 'V09' + i, category: 'Misc' + i, amount: 96000, createdAt: at(d * 24) }));
  const anchor = pr('PR-9', { createdAt: at(1) });
  const r = scorePrs(anchor, history.concat([pr('PR-8')]), ctx());
  assert.ok(r.patterns.includes('P7'));
});

test('score is clamped to 0..100 and works with string-typed fields', () => {
  const anchor = pr('PR-2', { amount: '95000', isEmergency: 'true', createdAt: at(1) });
  const r = scorePrs(anchor, [pr('PR-1', { amount: '95000', isEmergency: 'true' })],
    ctx({ vendor: { isRecurring: 'true' } }));
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.equal(r.combinedAmount, 190000);
});

test('jaccard ignores numbers and stopwords', () => {
  assert.equal(jaccard('Laptop 14 inch i7', 'laptop 15 inch i7'), 1);
  assert.equal(jaccard('', ''), 0);
});
