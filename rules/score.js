// SplitSentinel rule engine.
// Pure function, no I/O. The Flow's rule-engine script node inlines this file's source,
// so keep it plain ES2019 (no imports, no top-level await) and change it only here.

var DAY_MS = 86400000;
var LOOKBACK_DAYS = 30;
var HISTORY_DAYS = 90;
var NEAR_LIMIT_MIN = 0.85;
var HABIT_MIN = 0.9;
var BURST_HOURS = 72;
var SIMILARITY_MIN = 0.7;
var EXCLUDED_STATUSES = ['Draft', 'Rejected'];
var STOPWORDS = ['and', 'for', 'the', 'with', 'from', 'pcs', 'nos', 'qty', 'units', 'set', 'of'];

function num(x) {
  var n = Number(x);
  return isFinite(n) ? n : 0;
}

function ts(x) {
  var t = Date.parse(x);
  return isFinite(t) ? t : 0;
}

function sameText(a, b) {
  return a != null && b != null && String(a).trim() !== '' && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

function sortedTiers(matrix) {
  return (matrix || []).slice().sort(function (a, b) { return num(a.minAmount) - num(b.minAmount); });
}

function tierFor(amount, matrix) {
  var tiers = sortedTiers(matrix);
  for (var i = 0; i < tiers.length; i++) {
    var max = tiers[i].maxAmount;
    var hasMax = max !== null && max !== undefined && max !== '';
    if (amount >= num(tiers[i].minAmount) && (!hasMax || amount < num(max))) {
      return { tier: tiers[i], index: i };
    }
  }
  return { tier: null, index: -1 };
}

// Ratio of amount to the nearest ceiling above it: its tier's upper bound or the requester's limit.
function ceilingRatio(amount, matrix, requesterLimit) {
  var best = 0;
  var t = tierFor(amount, matrix).tier;
  if (t && t.maxAmount !== null && t.maxAmount !== undefined && t.maxAmount !== '') {
    best = Math.max(best, amount / num(t.maxAmount));
  }
  var limit = num(requesterLimit);
  if (limit > 0 && amount <= limit) best = Math.max(best, amount / limit);
  return best;
}

// Indian digit grouping for signal text (12,34,567). Named apart from the Flow's own display helpers.
function groupInr(n) {
  var s = String(Math.round(num(n))), last3 = s.slice(-3), rest = s.slice(0, -3);
  return 'INR ' + (rest ? rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' : '') + last3;
}

function tokens(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9]+/).filter(function (w) {
    return w.length > 2 && !/^\d+$/.test(w) && STOPWORDS.indexOf(w) < 0;
  });
}

function jaccard(a, b) {
  var sa = {}, sb = {}, inter = 0, union = 0, k;
  tokens(a).forEach(function (w) { sa[w] = true; });
  tokens(b).forEach(function (w) { sb[w] = true; });
  for (k in sa) { union++; if (sb[k]) inter++; }
  for (k in sb) { if (!sa[k]) union++; }
  return union === 0 ? 0 : inter / union;
}

function isCandidate(anchor, pr) {
  if (sameText(pr.vendorId, anchor.vendorId) && sameText(pr.requesterId, anchor.requesterId)) return true;
  if (sameText(pr.vendorId, anchor.vendorId) && sameText(pr.costCenter, anchor.costCenter)) return true;
  if (sameText(pr.projectCode, anchor.projectCode)) return true;
  if (sameText(pr.requesterId, anchor.requesterId) && sameText(pr.category, anchor.category)) return true;
  return false;
}

function validBlanket(ref, vendorId, atTime, blanketPos) {
  for (var i = 0; i < (blanketPos || []).length; i++) {
    var b = blanketPos[i];
    if (sameText(b.blanketPoId, ref) && sameText(b.vendorId, vendorId)
      && atTime >= ts(b.validFrom) && atTime <= ts(b.validTo) + DAY_MS - 1) return true;
  }
  return false;
}

/**
 * @param anchor  the PR being checked
 * @param prs     PRs created in the 90 days before the anchor (any requester); the anchor itself is ignored
 * @param ctx     { approvalMatrix, requester, vendor, blanketPos }
 */
function scorePrs(anchor, prs, ctx) {
  ctx = ctx || {};
  var matrix = ctx.approvalMatrix || [];
  var requester = ctx.requester || {};
  var vendor = ctx.vendor || {};
  var anchorTime = ts(anchor.createdAt);
  var anchorAmount = num(anchor.amount);
  var requesterLimit = num(requester.approvalLimit);

  var prior = (prs || []).filter(function (p) {
    var t = ts(p.createdAt);
    return !sameText(p.prId, anchor.prId) && t <= anchorTime && t >= anchorTime - HISTORY_DAYS * DAY_MS
      && EXCLUDED_STATUSES.indexOf(String(p.status)) < 0;
  });
  var candidates = prior.filter(function (p) {
    return ts(p.createdAt) >= anchorTime - LOOKBACK_DAYS * DAY_MS && isCandidate(anchor, p);
  });
  var group = [anchor].concat(candidates);
  var combined = group.reduce(function (s, p) { return s + num(p.amount); }, 0);
  var anchorTier = tierFor(anchorAmount, matrix);
  var combinedTier = tierFor(combined, matrix);
  var crossesTier = combinedTier.index > anchorTier.index;
  var exceedsRequesterLimit = requesterLimit > 0 && anchorAmount <= requesterLimit && combined > requesterLimit;

  var signals = [];
  function add(code, points, detail) { signals.push({ code: code, points: points, detail: detail }); }

  if (candidates.length > 0) {
    var p1 = candidates.filter(function (p) { return sameText(p.vendorId, anchor.vendorId) && sameText(p.requesterId, anchor.requesterId); });
    if (p1.length) add('P1', 25, 'Same requester and vendor: ' + p1.map(function (p) { return p.prId; }).join(', '));

    var p5 = candidates.filter(function (p) {
      return sameText(p.vendorId, anchor.vendorId) && !sameText(p.requesterId, anchor.requesterId) && sameText(p.costCenter, anchor.costCenter);
    });
    if (p5.length) add('P5', 15, 'Same vendor and cost centre, different requester: ' + p5.map(function (p) { return p.prId; }).join(', '));

    if (crossesTier || exceedsRequesterLimit) {
      add('TIER', 20, 'Combined ' + groupInr(combined) + ' needs ' + (combinedTier.tier ? combinedTier.tier.tierId : '?')
        + (crossesTier ? ' (this PR alone: ' + (anchorTier.tier ? anchorTier.tier.tierId : '?') + ')' : '')
        + (exceedsRequesterLimit ? '; over the requester\'s ' + groupInr(requesterLimit) + ' limit' : ''));
    }

    var nearAll = group.every(function (p) { return ceilingRatio(num(p.amount), matrix, requesterLimit) >= NEAR_LIMIT_MIN; });
    if (nearAll) add('P2', 15, 'Each PR sits just under an approval limit (85-100% of it)');

    var times = group.map(function (p) { return ts(p.createdAt); });
    if (Math.max.apply(null, times) - Math.min.apply(null, times) <= BURST_HOURS * 3600000) {
      add('P6', 10, 'All raised within 72 hours of each other');
    }

    var similar = candidates.every(function (p) { return jaccard(p.description, anchor.description) >= SIMILARITY_MIN; });
    if (similar) add('P3', 10, 'Almost identical item descriptions');

    var sameProject = anchor.projectCode && group.every(function (p) { return sameText(p.projectCode, anchor.projectCode); });
    if (sameProject) add('PROJ', 10, 'All for the same project, ' + anchor.projectCode);

    var habit = prior.filter(function (p) {
      return sameText(p.requesterId, anchor.requesterId) && ceilingRatio(num(p.amount), matrix, requesterLimit) >= HABIT_MIN;
    });
    if (habit.length >= 3) add('P7', 10, 'The requester raised ' + habit.length + ' PRs in the last 90 days just under an approval limit');

    if (vendor.isRecurring === true || String(vendor.isRecurring).toLowerCase() === 'true') {
      add('X_RECURRING', -20, (vendor.name || anchor.vendorId) + ' is a recurring-spend vendor (lowers the score)');
    }

    var blanketRef = anchor.blanketPoRef;
    var allBlanket = blanketRef && group.every(function (p) {
      return sameText(p.blanketPoRef, blanketRef) && validBlanket(blanketRef, p.vendorId, ts(p.createdAt), ctx.blanketPos);
    });
    if (allBlanket) add('X_BLANKET', -30, 'All are call-offs against valid blanket PO ' + blanketRef + ' (lowers the score)');

    var allEmergency = group.every(function (p) { return p.isEmergency === true || String(p.isEmergency).toLowerCase() === 'true'; });
    if (allEmergency) add('X_EMERGENCY', -10, 'All are flagged as emergencies (lowers the score)');
  }

  var total = signals.reduce(function (s, x) { return s + x.points; }, 0);
  var score = Math.max(0, Math.min(100, total));
  var route = score < 30 ? 'RELEASE' : score < 60 ? 'AGENT' : 'AGENT_HUMAN_REQUIRED';

  return {
    score: score,
    route: route,
    patterns: signals.filter(function (x) { return x.points > 0; }).map(function (x) { return x.code; }),
    signals: signals,
    groupPrIds: group.map(function (p) { return p.prId; }),
    combinedAmount: combined,
    anchorTier: anchorTier.tier ? anchorTier.tier.tierId : null,
    combinedTier: combinedTier.tier ? combinedTier.tier.tierId : null,
    crossesTier: crossesTier,
    requesterLimit: requesterLimit,
    exceedsRequesterLimit: exceedsRequesterLimit
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { scorePrs: scorePrs, tierFor: tierFor, jaccard: jaccard };
}
