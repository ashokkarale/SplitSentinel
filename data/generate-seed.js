// Generates deterministic SplitSentinel seed data into data/seed/.
// Usage: node data/generate-seed.js
// Every planted scenario is scored with rules/score.js and the run fails if a scenario
// no longer produces its expected rule route, so seed data and rules can't drift apart.

const fs = require('fs');
const path = require('path');
const { scorePrs } = require('../rules/score.js');

const OUT = path.join(__dirname, 'seed');
const EMAIL_DOMAIN = 'splitsentinel.example';

// Mulberry32: small seeded PRNG so reruns produce identical files.
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261104);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

function email(name) {
  return name.toLowerCase().replace(/[^a-z]+/g, '.') + '@' + EMAIL_DOMAIN;
}

// ---------- reference data ----------

const approvalMatrix = [
  { tierId: 'T1', minAmount: 0, maxAmount: 100000, approverRole: 'LineManager', quotesRequired: 1, rfqRequired: false },
  { tierId: 'T2', minAmount: 100000, maxAmount: 500000, approverRole: 'DeptHead', quotesRequired: 3, rfqRequired: false },
  { tierId: 'T3', minAmount: 500000, maxAmount: 2500000, approverRole: 'CFO', quotesRequired: 3, rfqRequired: true },
  { tierId: 'T4', minAmount: 2500000, maxAmount: null, approverRole: 'CFOCommittee', quotesRequired: 3, rfqRequired: true },
];

const people = [
  // [employeeId, name, costCenter, role, managerId, approvalLimit]
  ['E401', 'Rohan Malhotra', 'CC-FIN', 'CFO', null, 2500000],
  ['E301', 'Kavita Bose', 'CC-IT', 'DeptHead', 'E401', 500000],
  ['E302', 'Manish Tiwari', 'CC-OPS', 'DeptHead', 'E401', 500000],
  ['E303', 'Shalini Pillai', 'CC-FIN', 'DeptHead', 'E401', 500000],
  ['E304', 'Ajay Saxena', 'CC-MKT', 'DeptHead', 'E401', 500000],
  ['E201', 'Nikhil Bansal', 'CC-IT', 'LineManager', 'E301', 100000],
  ['E202', 'Ritu Chawla', 'CC-OPS', 'LineManager', 'E302', 100000],
  ['E203', 'Gaurav Khanna', 'CC-FIN', 'LineManager', 'E303', 100000],
  ['E204', 'Divya Menon', 'CC-MKT', 'LineManager', 'E304', 100000],
  ['E501', 'Harish Patil', 'CC-FIN', 'Audit', 'E401', 0],
  ['E601', 'Sneha Kulkarni', 'CC-OPS', 'ProcurementOps', 'E302', 0],
  ['E101', 'Priya Sharma', 'CC-IT', 'Requester', 'E201', 100000],
  ['E102', 'Rahul Verma', 'CC-OPS', 'Requester', 'E202', 100000],
  ['E103', 'Anita Desai', 'CC-FIN', 'Requester', 'E203', 100000],
  ['E104', 'Farhan Qureshi', 'CC-OPS', 'Requester', 'E202', 100000],
  ['E105', 'Neha Kapoor', 'CC-MKT', 'Requester', 'E204', 100000],
  ['E106', 'Arjun Mehta', 'CC-MKT', 'Requester', 'E204', 100000],
  ['E107', 'Kiran Rao', 'CC-OPS', 'Requester', 'E202', 100000],
  ['E108', 'Vikram Singh', 'CC-FIN', 'Requester', 'E203', 100000],
  ['E109', 'Suresh Nair', 'CC-OPS', 'Requester', 'E202', 100000],
  ['E110', 'Meera Iyer', 'CC-MKT', 'Requester', 'E204', 100000],
  ['E111', 'Deepak Joshi', 'CC-IT', 'Requester', 'E201', 100000],
  ['E112', 'Pooja Reddy', 'CC-FIN', 'Requester', 'E203', 100000],
  ['E113', 'Sanjay Gupta', 'CC-OPS', 'Requester', 'E202', 100000],
  ['E114', 'Lata Krishnan', 'CC-MKT', 'Requester', 'E204', 100000],
];
const employees = people.map(([employeeId, name, costCenter, role, managerId, approvalLimit]) =>
  ({ employeeId, name, email: email(name), managerId, costCenter, approvalLimit, role }));

const vendors = [
  ['V001', 'Nimbus Systems', 'IT Hardware', false],
  ['V002', 'Vertex Devices', 'IT Hardware', false],
  ['V003', 'Orbit Peripherals', 'IT Hardware', false],
  ['V004', 'PaperTrail Supplies', 'Stationery', true],
  ['V005', 'SparkClean Services', 'Facilities', true],
  ['V006', 'Chai Point Pantry', 'Pantry', true],
  ['V007', 'SwiftRoute Couriers', 'Courier', true],
  ['V008', 'Inkwell Print House', 'Marketing', false],
  ['V009', 'Gather Events', 'Events', false],
  ['V010', 'Oakline Furniture', 'Furniture', false],
  ['V011', 'Urban Facility Services', 'Facilities', false],
  ['V012', 'CloudNest Software', 'Software', false],
  ['V013', 'Bytecraft Licensing', 'Software', false],
  ['V014', 'Skyway Travels', 'Travel', false],
  ['V015', 'Shakti Electricals', 'Electrical', false],
  ['V016', 'Pixel Accessories', 'IT Hardware', false],
].map(([vendorId, name, category, isRecurring]) =>
  ({ vendorId, name, category, isRecurring, contactEmail: 'sales@' + name.toLowerCase().replace(/[^a-z]+/g, '') + '.example' }));

const blanketPos = [
  { blanketPoId: 'BPO-001', vendorId: 'V011', category: 'Facilities', approvedAmount: 1000000, consumedAmount: 240000, validFrom: '2026-10-01', validTo: '2027-03-31', approvedBy: 'E302' },
  { blanketPoId: 'BPO-002', vendorId: 'V002', category: 'IT Hardware', approvedAmount: 1500000, consumedAmount: 380000, validFrom: '2026-07-01', validTo: '2026-12-31', approvedBy: 'E401' },
  { blanketPoId: 'BPO-003', vendorId: 'V008', category: 'Marketing', approvedAmount: 600000, consumedAmount: 120000, validFrom: '2026-04-01', validTo: '2026-09-30', approvedBy: 'E304' },
];

const empById = Object.fromEntries(employees.map((e) => [e.employeeId, e]));
const vendorById = Object.fromEntries(vendors.map((v) => [v.vendorId, v]));

function pr(prId, requesterId, vendorId, description, amount, createdAt, extra) {
  const quantity = (extra && extra.quantity) || 1;
  return Object.assign({
    prId, requesterId, costCenter: empById[requesterId].costCenter, projectCode: null, vendorId,
    category: vendorById[vendorId].category, description, quantity, unitPrice: Math.round(amount / quantity), amount,
    currency: 'INR', deliverySite: 'Mumbai HQ', blanketPoRef: null, isEmergency: false, createdAt, status: 'Released',
    splitCaseId: null,
  }, extra);
}

// ---------- planted scenarios ----------
// The last PR of each scenario is its anchor (status Submitted); expectedRoute is what the rule engine must return.

const scenarios = [
  {
    key: 'PRIYA_LAPTOPS', expectedRoute: 'AGENT_HUMAN_REQUIRED', expectedVerdict: 'SPLIT',
    note: '3 x 95k laptops, same requester and vendor, within 3 days; each T1, combined T2',
    prs: [
      pr('PR-2001', 'E101', 'V001', 'Laptop 14 inch i7 16GB RAM 512GB SSD', 95000, '2026-11-10T09:30:00+05:30'),
      pr('PR-2002', 'E101', 'V001', 'Laptop 14 inch i7 16GB RAM 512GB SSD', 95000, '2026-11-11T11:00:00+05:30', { status: 'UnderReview' }),
      pr('PR-2003', 'E101', 'V001', 'Laptop 14 inch i7 16GB RAM 512GB SSD', 95000, '2026-11-12T15:00:00+05:30', { status: 'Submitted' }),
    ],
  },
  {
    key: 'APOLLO_KIT', expectedRoute: 'AGENT', expectedVerdict: 'LIKELY_SPLIT',
    note: 'Laptops, chargers and docks for project APOLLO from three vendors over 6 days; rules alone score low',
    prs: [
      pr('PR-2011', 'E102', 'V002', 'Laptops for Apollo field team', 95000, '2026-11-03T10:00:00+05:30', { projectCode: 'APOLLO', deliverySite: 'Pune Plant' }),
      pr('PR-2012', 'E102', 'V003', '65W USB-C chargers', 40000, '2026-11-06T12:00:00+05:30', { projectCode: 'APOLLO', deliverySite: 'Pune Plant', quantity: 20 }),
      pr('PR-2013', 'E102', 'V016', 'USB-C docking stations', 60000, '2026-11-09T16:00:00+05:30', { projectCode: 'APOLLO', deliverySite: 'Pune Plant', quantity: 20, status: 'Submitted' }),
    ],
  },
  {
    key: 'STATIONERY', expectedRoute: 'RELEASE', expectedVerdict: 'NOT_SPLIT', expectedException: 'RECURRING',
    note: 'Monthly stationery from a recurring vendor',
    prs: [
      ['2026-06-08', 36000], ['2026-07-08', 42000], ['2026-08-07', 31000], ['2026-09-08', 44000], ['2026-10-08', 38000],
    ].map(([d, a], i) => pr('PR-202' + i, 'E103', 'V004', 'Monthly office stationery', a, d + 'T10:00:00+05:30'))
      .concat([pr('PR-2025', 'E103', 'V004', 'Monthly office stationery', 40000, '2026-11-05T10:00:00+05:30', { status: 'Submitted' })]),
  },
  {
    key: 'BLANKET_CALLOFFS', expectedRoute: 'RELEASE', expectedVerdict: 'NOT_SPLIT', expectedException: 'BLANKET_PO',
    note: 'AC maintenance call-offs against valid blanket PO BPO-001',
    prs: [
      pr('PR-2031', 'E104', 'V011', 'AC maintenance call-off Block A', 80000, '2026-10-20T09:00:00+05:30', { blanketPoRef: 'BPO-001' }),
      pr('PR-2032', 'E104', 'V011', 'AC maintenance call-off Block B', 80000, '2026-10-27T09:00:00+05:30', { blanketPoRef: 'BPO-001' }),
      pr('PR-2033', 'E104', 'V011', 'AC maintenance call-off Block C', 80000, '2026-11-03T09:00:00+05:30', { blanketPoRef: 'BPO-001' }),
      pr('PR-2034', 'E104', 'V011', 'AC maintenance call-off Block D', 80000, '2026-11-10T09:00:00+05:30', { blanketPoRef: 'BPO-001', status: 'Submitted' }),
    ],
  },
  {
    key: 'MKT_COLLUSION', expectedRoute: 'AGENT', expectedVerdict: 'LIKELY_SPLIT',
    note: 'Two marketing requesters, same vendor and cost centre, same day; each T2, combined T3 (RFQ)',
    prs: [
      pr('PR-2041', 'E105', 'V008', 'Diwali campaign print flyers and standees', 260000, '2026-11-13T10:00:00+05:30', { status: 'UnderReview' }),
      pr('PR-2042', 'E106', 'V008', 'Diwali campaign print flyers and standees', 260000, '2026-11-13T14:30:00+05:30', { status: 'Submitted' }),
    ],
  },
  {
    key: 'SEPARATE_PROJECTS', expectedRoute: 'AGENT', expectedVerdict: 'NOT_SPLIT', expectedException: 'SEPARATE_PROJECT',
    note: 'Same vendor and requester, but different projects, cost centres, sites and purposes',
    prs: [
      pr('PR-2051', 'E107', 'V010', 'Workstations for Pune office fit-out', 120000, '2026-11-04T11:00:00+05:30', { projectCode: 'PUNE-FITOUT', deliverySite: 'Pune Office', quantity: 8 }),
      pr('PR-2052', 'E107', 'V010', 'Training room chairs and tables', 110000, '2026-11-06T11:00:00+05:30', { projectCode: 'BLR-TRAINING', costCenter: 'CC-FIN', deliverySite: 'Bengaluru Training Centre', quantity: 30, status: 'Submitted' }),
    ],
  },
  {
    key: 'HABITUAL', expectedRoute: 'AGENT', expectedVerdict: 'LIKELY_SPLIT',
    note: 'Requester who keeps landing at 92-99% of the T1 ceiling; two software PRs combine to T2',
    prs: [
      pr('PR-2061', 'E108', 'V014', 'Team offsite travel bookings', 93000, '2026-08-20T10:00:00+05:30'),
      pr('PR-2062', 'E108', 'V009', 'Quarterly finance town hall venue', 96000, '2026-09-10T10:00:00+05:30'),
      pr('PR-2063', 'E108', 'V010', 'Ergonomic chairs for finance bay', 97500, '2026-09-30T10:00:00+05:30'),
      pr('PR-2064', 'E108', 'V013', 'Reporting tool licences, 10 seats', 98000, '2026-10-25T10:00:00+05:30'),
      pr('PR-2065', 'E108', 'V012', 'Cloud budgeting software subscription', 97000, '2026-11-11T10:00:00+05:30', { status: 'Submitted' }),
    ],
  },
  {
    key: 'EMERGENCY', expectedRoute: 'AGENT', expectedVerdict: 'NOT_SPLIT', expectedException: 'EMERGENCY',
    note: 'Two emergency PRs for a generator breakdown on the same day',
    prs: [
      pr('PR-2071', 'E109', 'V015', 'Emergency DG set repair: burnt alternator rewinding', 70000, '2026-11-07T08:15:00+05:30', { isEmergency: true, deliverySite: 'Pune Plant' }),
      pr('PR-2072', 'E109', 'V015', 'Emergency DG set repair: replacement control panel parts', 60000, '2026-11-07T13:40:00+05:30', { isEmergency: true, deliverySite: 'Pune Plant', status: 'Submitted' }),
    ],
  },
  {
    key: 'CLEAN', expectedRoute: 'RELEASE', expectedVerdict: null,
    note: 'Single PR with no related history',
    prs: [pr('PR-2081', 'E110', 'V009', 'Venue booking for customer meetup', 45000, '2026-11-12T12:00:00+05:30', { status: 'Submitted' })],
  },
];

// ---------- background PRs ----------

const backgroundRequesters = ['E111', 'E112', 'E113', 'E114'];
const backgroundItems = {
  'IT Hardware': ['Monitors 27 inch', 'Keyboards and mice', 'Network switch', 'External SSDs'],
  Facilities: ['Deep cleaning of floor 3', 'Pest control service'],
  Pantry: ['Pantry supplies', 'Coffee machine servicing'],
  Courier: ['Courier charges'],
  Marketing: ['Product brochures', 'Trade show banners'],
  Events: ['Team lunch catering', 'Workshop venue'],
  Furniture: ['Filing cabinets', 'Meeting room table'],
  Software: ['Design tool licences', 'Antivirus renewal'],
  Travel: ['Client visit flights', 'Hotel bookings'],
  Electrical: ['LED panel replacement', 'UPS battery replacement'],
};
const scenarioPrs = scenarios.flatMap((s) => s.prs);
const anchors = scenarios.map((s) => s.prs[s.prs.length - 1]);
const anchorIds = new Set(anchors.map((a) => a.prId));
const DAY = 86400000;

// A background PR must never fall inside any scenario anchor's candidate group.
function touchesScenario(bg) {
  const t = Date.parse(bg.createdAt);
  return anchors.some((a) => {
    const ta = Date.parse(a.createdAt);
    if (t > ta || t < ta - 90 * DAY) return false;
    const r = scorePrs(a, [bg], ctxFor(a));
    return r.groupPrIds.length > 1 || r.patterns.includes('P7');
  });
}

function ctxFor(anchor) {
  return {
    approvalMatrix,
    requester: empById[anchor.requesterId],
    vendor: vendorById[anchor.vendorId],
    blanketPos,
  };
}

const background = [];
const start = Date.parse('2026-09-15T09:00:00+05:30');
let n = 1001;
while (background.length < 50) {
  const requesterId = pick(backgroundRequesters);
  const vendor = pick(vendors.filter((v) => !v.isRecurring || rand() < 0.3));
  const description = pick(backgroundItems[vendor.category] || ['General supplies']);
  const amount = between(5, 280) * 1000;
  const createdAt = new Date(start + between(0, 60) * DAY + between(0, 8) * 3600000).toISOString();
  const status = rand() < 0.08 ? 'Rejected' : rand() < 0.05 ? 'Draft' : 'Released';
  const candidate = pr('PR-' + n++, requesterId, vendor.vendorId, description, amount, createdAt, { status });
  if (!touchesScenario(candidate)) background.push(candidate);
}

const purchaseRequisitions = background.concat(scenarioPrs)
  .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

// ---------- self-check ----------

const scenarioResults = scenarios.map((s) => {
  const anchor = s.prs[s.prs.length - 1];
  const history = purchaseRequisitions.filter((p) => !anchorIds.has(p.prId) || p.prId === anchor.prId);
  const result = scorePrs(anchor, history, ctxFor(anchor));
  if (result.route !== s.expectedRoute) {
    throw new Error(`${s.key}: expected route ${s.expectedRoute}, got ${result.route} (score ${result.score}, ${result.patterns.join(',')})`);
  }
  return {
    key: s.key, anchorPrId: anchor.prId, note: s.note, expectedRoute: s.expectedRoute,
    expectedVerdict: s.expectedVerdict, expectedException: s.expectedException || null,
    ruleScore: result.score, rulePatterns: result.patterns, groupPrIds: result.groupPrIds,
    combinedAmount: result.combinedAmount, combinedTier: result.combinedTier,
  };
});

// ---------- write ----------

function csv(rows) {
  const cols = Object.keys(rows[0]);
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return [cols.join(',')].concat(rows.map((r) => cols.map((c) => cell(r[c])).join(','))).join('\n') + '\n';
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  approval_matrix: approvalMatrix, employees, vendors, blanket_pos: blanketPos,
  purchase_requisitions: purchaseRequisitions,
};
for (const [name, rows] of Object.entries(files)) {
  fs.writeFileSync(path.join(OUT, name + '.csv'), csv(rows));
  fs.writeFileSync(path.join(OUT, name + '.json'), JSON.stringify(rows, null, 2) + '\n');
}
fs.writeFileSync(path.join(OUT, 'scenarios.json'), JSON.stringify(scenarioResults, null, 2) + '\n');

console.log(`employees=${employees.length} vendors=${vendors.length} blanketPos=${blanketPos.length} `
  + `approvalTiers=${approvalMatrix.length} purchaseRequisitions=${purchaseRequisitions.length} `
  + `(background=${background.length}, scenario=${scenarioPrs.length})`);
for (const r of scenarioResults) {
  console.log(`  ${r.key.padEnd(18)} ${r.anchorPrId}  score=${String(r.ruleScore).padStart(3)}  ${r.expectedRoute.padEnd(21)} ${r.rulePatterns.join(',')}`);
}
