// Post-compile fix for SplitSentinel.flow.
// Usage: node tools/postcompile.js SplitSentinel/SplitSentinel/SplitSentinel.flow
//
// When the Flow source supplies `.layout(...)`, `uip maestro flow compile` (builder SDK 6.74.2)
// leaves `inputs.errorHandlingEnabled` unset on some nodes that have an `.onError(...)`
// handler, and `flow validate` then refuses their "error" edges. `flow format` would set the
// flag but also replaces the hand-authored layout. This sets the flag on exactly the nodes
// that are the source of an `error` edge — the fix the validator names — and nothing else.

// It also gives every human-task form a content-derived `schemaId`. Compile derives the id from
// the flow and step ids only, so it stays the same when a form's fields or buttons change, and
// Action Center keeps rendering the form it registered first under that id (old fields, old
// buttons, new data). Hashing the fields and outcomes gives each form version its own id.

const fs = require('fs');
const crypto = require('crypto');

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

// RFC 4122 name-based (SHA-1, version 5 style) UUID from a string.
function contentUuid(text) {
  const h = crypto.createHash('sha1').update(text).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

const reschemed = [];
for (const node of flow.nodes) {
  const schema = node.inputs && node.inputs.schema;
  // Quick forms only: an Action App's form comes from the app itself.
  if (node.type !== 'uipath.human-in-the-loop.quick-form' || !schema || !schema.schemaId) continue;
  const id = contentUuid(`${flow.id}/${node.id}/${JSON.stringify({ fields: schema.fields, outcomes: schema.outcomes })}`);
  if (schema.schemaId !== id) {
    schema.schemaId = id;
    reschemed.push(node.id);
  }
}

if (fixed.length || reschemed.length) fs.writeFileSync(file, bom + JSON.stringify(flow, null, 2) + '\n');
console.log(JSON.stringify({
  errorHandlingEnabledSet: fixed,
  alreadySet: [...needsFlag].filter((id) => !fixed.includes(id)),
  formSchemaIdUpdated: reschemed,
}));
