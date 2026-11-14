// Post-compile fix for SplitSentinel.flow.
// Usage: node tools/postcompile.js SplitSentinel/SplitSentinel/SplitSentinel.flow
//
// When the Flow source supplies `.layout(...)`, `uip maestro flow compile` (builder SDK 6.74.2)
// leaves `inputs.errorHandlingEnabled` unset on some nodes that have an `.onError(...)`
// handler, and `flow validate` then refuses their "error" edges. `flow format` would set the
// flag but also replaces the hand-authored layout. This sets the flag on exactly the nodes
// that are the source of an `error` edge — the fix the validator names — and nothing else.

const fs = require('fs');

const file = process.argv[2];
if (!file) {
  console.error('usage: node tools/postcompile.js <path to .flow>');
  process.exit(2);
}

const raw = fs.readFileSync(file, 'utf8');
const bom = raw.charCodeAt(0) === 0xfeff ? '﻿' : '';
const flow = JSON.parse(bom ? raw.slice(1) : raw);

const needsFlag = new Set(flow.edges.filter((e) => e.sourcePort === 'error').map((e) => e.sourceNodeId));
const fixed = [];
for (const node of flow.nodes) {
  if (!needsFlag.has(node.id)) continue;
  node.inputs = node.inputs || {};
  if (node.inputs.errorHandlingEnabled !== true) {
    node.inputs.errorHandlingEnabled = true;
    fixed.push(node.id);
  }
}

if (fixed.length) fs.writeFileSync(file, bom + JSON.stringify(flow, null, 2) + '\n');
console.log(JSON.stringify({ errorHandlingEnabledSet: fixed, alreadySet: [...needsFlag].filter((id) => !fixed.includes(id)) }));
