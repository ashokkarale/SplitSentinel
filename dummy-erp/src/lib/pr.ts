// Purchase requisition model: mirrors the Data Fabric entity `PurchaseRequisition`.
// Field names are the entity's own (camelCase); Data Fabric matches keys case-sensitively
// and silently drops unknown keys, so every write goes through `toRecord()`.

export const PR_STATUSES = [
  'Draft', 'Submitted', 'UnderReview', 'OnHold', 'Unverified', 'Released', 'Consolidated', 'Rejected',
] as const;

/** Statuses a requester may create a PR in. The rest are set by the approval process. */
export const CREATE_STATUSES = ['Submitted', 'Draft'] as const;

export interface PurchaseRequisition {
  prId: string;
  requesterId: string;
  costCenter: string;
  projectCode: string | null;
  vendorId: string;
  category: string;
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
  currency: string;
  deliverySite: string;
  blanketPoRef: string | null;
  isEmergency: boolean;
  createdAt: string; // ISO 8601
  status: string;
  splitCaseId?: string | null; // written by the approval checker, never by the ERP
}

/** Columns of the CSV template, in entity order. `splitCaseId` is owned by the checker. */
export const CSV_COLUMNS = [
  'prId', 'requesterId', 'costCenter', 'projectCode', 'vendorId', 'category', 'description',
  'quantity', 'unitPrice', 'amount', 'currency', 'deliverySite', 'blanketPoRef', 'isEmergency',
  'createdAt', 'status',
] as const;

export const FIELD_LABELS: Record<string, string> = {
  prId: 'PR number', requesterId: 'Requester', costCenter: 'Cost centre', projectCode: 'Project code',
  vendorId: 'Vendor', category: 'Category', description: 'Description', quantity: 'Quantity',
  unitPrice: 'Unit price', amount: 'Amount', currency: 'Currency', deliverySite: 'Delivery site',
  blanketPoRef: 'Blanket PO', isEmergency: 'Emergency', createdAt: 'Created at', status: 'Status',
};

const LIMITS: Record<string, number> = {
  prId: 20, requesterId: 20, costCenter: 20, projectCode: 30, vendorId: 20, category: 50,
  description: 1000, currency: 3, deliverySite: 100, blanketPoRef: 20, status: 20,
};

export interface Masters {
  employees: Map<string, { name: string; costCenter: string }>;
  vendors: Map<string, { name: string; category: string }>;
}

export type RawRow = Record<string, string | undefined>;

export interface Checked {
  pr: PurchaseRequisition | null;
  errors: string[];
  warnings: string[];
}

const text = (v: unknown) => (v === undefined || v === null ? '' : String(v)).trim();

function parseNumber(v: string): number | null {
  if (!v) return null;
  const n = Number(v.replace(/[,\s₹]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

function parseBool(v: string): boolean | null {
  if (!v) return false;
  const s = v.toLowerCase();
  if (['true', 'yes', 'y', '1'].includes(s)) return true;
  if (['false', 'no', 'n', '0'].includes(s)) return false;
  return null;
}

/** Accepts ISO 8601 (with or without offset) or "YYYY-MM-DD HH:mm"; returns ISO or null. */
function parseDate(v: string): string | null {
  if (!v) return new Date().toISOString();
  const t = Date.parse(v.includes('T') || !v.includes(' ') ? v : v.replace(' ', 'T'));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

/**
 * Validates one requisition (from the form or a CSV row) and normalises it to the entity's
 * types. Fills defaults: currency INR, status Submitted, createdAt now, amount = qty x price,
 * cost centre from the requester, category from the vendor.
 */
export function checkPr(raw: RawRow, masters: Masters, existingIds: Set<string>): Checked {
  const errors: string[] = [];
  const warnings: string[] = [];
  const get = (k: string) => text(raw[k]);

  const prId = get('prId');
  const requesterId = get('requesterId');
  const vendorId = get('vendorId');
  const description = get('description');
  if (!prId) errors.push('PR number is required');
  else if (existingIds.has(prId.toUpperCase())) errors.push(`${prId} already exists`);
  if (!requesterId) errors.push('Requester is required');
  if (!vendorId) errors.push('Vendor is required');
  if (!description) errors.push('Description is required');

  const employee = masters.employees.get(requesterId);
  const vendor = masters.vendors.get(vendorId);
  if (requesterId && masters.employees.size && !employee) errors.push(`Unknown requester ${requesterId}`);
  if (vendorId && masters.vendors.size && !vendor) errors.push(`Unknown vendor ${vendorId}`);

  const costCenter = get('costCenter') || employee?.costCenter || '';
  if (!costCenter) errors.push('Cost centre is required');
  else if (employee && employee.costCenter !== costCenter) {
    warnings.push(`${requesterId} belongs to ${employee.costCenter}, PR says ${costCenter}`);
  }
  const category = get('category') || vendor?.category || '';

  const quantity = parseNumber(get('quantity'));
  const unitPrice = parseNumber(get('unitPrice'));
  let amount = parseNumber(get('amount'));
  if (Number.isNaN(quantity)) errors.push('Quantity must be a number');
  if (Number.isNaN(unitPrice)) errors.push('Unit price must be a number');
  if (Number.isNaN(amount)) errors.push('Amount must be a number');
  if (quantity !== null && !Number.isNaN(quantity) && (!Number.isInteger(quantity) || quantity <= 0)) {
    errors.push('Quantity must be a whole number above 0');
  }
  const computed = quantity && unitPrice && !Number.isNaN(quantity) && !Number.isNaN(unitPrice)
    ? Math.round(quantity * unitPrice * 100) / 100 : null;
  if (amount === null) amount = computed;
  else if (computed !== null && !Number.isNaN(amount) && Math.abs(amount - computed) > 1) {
    warnings.push(`Amount ${amount} differs from quantity x unit price (${computed})`);
  }
  if (amount === null) errors.push('Amount is required (or quantity and unit price)');
  else if (!Number.isNaN(amount) && amount <= 0) errors.push('Amount must be above 0');

  const isEmergency = parseBool(get('isEmergency'));
  if (isEmergency === null) errors.push('Emergency must be true or false');
  const createdAt = parseDate(get('createdAt'));
  if (!createdAt) errors.push('Created at must be a date, e.g. 2026-11-14T10:30:00+05:30');

  const status = get('status') || 'Submitted';
  const statusMatch = PR_STATUSES.find((s) => s.toLowerCase() === status.toLowerCase());
  if (!statusMatch) errors.push(`Status must be one of ${PR_STATUSES.join(', ')}`);
  else if (!(CREATE_STATUSES as readonly string[]).includes(statusMatch)) {
    warnings.push(`New PR created directly in status ${statusMatch}`);
  }
  if (text(raw.splitCaseId)) warnings.push('splitCaseId is set by the approval checker and was ignored');

  const currency = (get('currency') || 'INR').toUpperCase();
  const pr: PurchaseRequisition = {
    prId: prId.toUpperCase(), requesterId, costCenter, projectCode: get('projectCode') || null,
    vendorId, category, description, quantity: quantity ?? 1, unitPrice: unitPrice ?? (amount ?? 0),
    amount: amount ?? 0, currency, deliverySite: get('deliverySite'), blanketPoRef: get('blanketPoRef') || null,
    isEmergency: isEmergency ?? false, createdAt: createdAt ?? '', status: statusMatch ?? status,
  };
  for (const [k, max] of Object.entries(LIMITS)) {
    const v = (pr as unknown as Record<string, unknown>)[k];
    if (typeof v === 'string' && v.length > max) errors.push(`${FIELD_LABELS[k]} is longer than ${max} characters`);
  }
  return { pr: errors.length ? null : pr, errors, warnings };
}

/** The record sent to Data Fabric: entity field names only, nulls left out. */
export function toRecord(pr: PurchaseRequisition): Record<string, unknown> {
  const rec: Record<string, unknown> = {};
  for (const k of CSV_COLUMNS) {
    const v = (pr as unknown as Record<string, unknown>)[k];
    if (v !== null && v !== undefined && v !== '') rec[k] = v;
  }
  return rec;
}

export function csvTemplate(): string {
  const example = [
    'PR-3001', 'E103', 'CC-FIN', '', 'V002', 'IT Hardware', 'Laptops for two new analysts',
    '2', '47500', '95000', 'INR', 'Mumbai HQ', '', 'false', '2026-11-15T10:30:00+05:30', 'Submitted',
  ];
  const quote = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return CSV_COLUMNS.join(',') + '\n' + example.map(quote).join(',') + '\n';
}

/** Next free PR number after the highest `PR-<n>` in use. */
export function nextPrId(ids: Iterable<string>): string {
  let max = 0;
  for (const id of ids) {
    const m = /^PR-(\d+)$/i.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `PR-${max + 1}`;
}

export const inr = (n: number) => {
  // en-IN grouping (12,34,567) with a rupee sign.
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);
  } catch {
    return '₹' + Math.round(n || 0).toLocaleString();
  }
};

export const shortDate = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
