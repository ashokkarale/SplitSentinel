import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type { Erp } from '../lib/erp';
import { errorText } from '../lib/erp';
import type { Masters } from '../lib/pr';
import { CREATE_STATUSES, checkPr, inr, nextPrId } from '../lib/pr';

interface Props {
  erp: Erp;
  masters: Masters | null;
  prIds: Set<string>;
  onCreated: () => Promise<void>;
  onShowList: () => void;
}

// datetime-local wants local "YYYY-MM-DDTHH:mm".
const nowLocal = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
};

const blank = () => ({
  prId: '', requesterId: '', costCenter: '', projectCode: '', vendorId: '', category: '', description: '',
  quantity: '1', unitPrice: '', amount: '', currency: 'INR', deliverySite: '', blanketPoRef: '',
  isEmergency: false, createdAt: nowLocal(), status: 'Submitted',
});

function Field({ label, children, hint, wide }: { label: string; children: ReactNode; hint?: string; wide?: boolean }) {
  return (
    <label className={wide ? 'sm:col-span-2 lg:col-span-3' : ''}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export default function NewRequisition({ erp, masters, prIds, onCreated, onShowList }: Props) {
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [created, setCreated] = useState<string | null>(null);

  const suggested = useMemo(() => nextPrId(prIds), [prIds]);
  useEffect(() => { setForm((f) => (f.prId ? f : { ...f, prId: suggested })); }, [suggested]);

  const set = (k: keyof ReturnType<typeof blank>, v: string | boolean) => setForm((f) => ({ ...f, [k]: v }));

  const onRequester = (id: string) => setForm((f) => ({ ...f, requesterId: id, costCenter: masters?.employees.get(id)?.costCenter ?? f.costCenter }));
  const onVendor = (id: string) => setForm((f) => ({ ...f, vendorId: id, category: masters?.vendors.get(id)?.category ?? f.category }));

  const qty = Number(form.quantity) || 0;
  const price = Number(form.unitPrice) || 0;
  const amount = form.amount ? Number(form.amount) : qty * price;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!masters) return;
    setCreated(null);
    const raw = {
      ...form, amount: String(amount || ''), isEmergency: String(form.isEmergency),
      createdAt: new Date(form.createdAt).toISOString(),
    };
    const { pr, errors: errs } = checkPr(raw, masters, prIds);
    setErrors(errs);
    if (!pr) return;
    setSaving(true);
    try {
      await erp.createPr(pr);
      setCreated(pr.prId);
      await onCreated();
      setForm(blank());
    } catch (err) {
      setErrors([errorText(err)]);
    } finally {
      setSaving(false);
    }
  };

  const employees = masters ? [...masters.employees.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)) : [];
  const vendors = masters ? [...masters.vendors.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name)) : [];

  return (
    <form className="panel" onSubmit={submit}>
      <div className="border-b border-slate-200 px-4 py-3">
        <h1 className="text-lg font-semibold">New purchase requisition</h1>
        <p className="text-sm text-slate-500">Submitted requisitions go to approval straight away.</p>
      </div>

      {created && (
        <div className="m-4 rounded border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
          {created} created.{' '}
          <button type="button" className="underline" onClick={onShowList}>View requisitions</button>
        </div>
      )}
      {errors.length > 0 && (
        <ul className="m-4 list-disc rounded border border-red-200 bg-red-50 p-3 pl-8 text-sm text-red-800">
          {errors.map((m) => <li key={m}>{m}</li>)}
        </ul>
      )}

      <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="PR number" hint={`Next free number: ${suggested}`}>
          <input className="field-input font-mono" value={form.prId} onChange={(e) => set('prId', e.target.value)} required maxLength={20} />
        </Field>
        <Field label="Requester">
          <select className="field-input" value={form.requesterId} onChange={(e) => onRequester(e.target.value)} required disabled={!masters}>
            <option value="">{masters ? 'Select…' : 'Loading…'}</option>
            {employees.map(([id, e]) => <option key={id} value={id}>{e.name} ({id})</option>)}
          </select>
        </Field>
        <Field label="Cost centre">
          <input className="field-input" value={form.costCenter} onChange={(e) => set('costCenter', e.target.value)} required maxLength={20} />
        </Field>

        <Field label="Vendor">
          <select className="field-input" value={form.vendorId} onChange={(e) => onVendor(e.target.value)} required disabled={!masters}>
            <option value="">{masters ? 'Select…' : 'Loading…'}</option>
            {vendors.map(([id, v]) => <option key={id} value={id}>{v.name} ({id})</option>)}
          </select>
        </Field>
        <Field label="Category">
          <input className="field-input" value={form.category} onChange={(e) => set('category', e.target.value)} maxLength={50} />
        </Field>
        <Field label="Project code" hint="Optional">
          <input className="field-input" value={form.projectCode} onChange={(e) => set('projectCode', e.target.value)} maxLength={30} />
        </Field>

        <Field label="Description" wide>
          <textarea className="field-input" rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} required maxLength={1000} />
        </Field>

        <Field label="Quantity">
          <input className="field-input" type="number" min={1} step={1} value={form.quantity} onChange={(e) => set('quantity', e.target.value)} required />
        </Field>
        <Field label="Unit price (INR)">
          <input className="field-input" type="number" min={0} step="0.01" value={form.unitPrice} onChange={(e) => set('unitPrice', e.target.value)} required />
        </Field>
        <Field label="Amount (INR)" hint={form.amount ? 'Entered manually' : `Quantity × unit price = ${inr(qty * price)}`}>
          <input className="field-input" type="number" min={0} step="0.01" placeholder={String(qty * price || '')} value={form.amount} onChange={(e) => set('amount', e.target.value)} />
        </Field>

        <Field label="Delivery site">
          <input className="field-input" value={form.deliverySite} onChange={(e) => set('deliverySite', e.target.value)} maxLength={100} />
        </Field>
        <Field label="Blanket PO" hint="Optional, e.g. BPO-001">
          <input className="field-input" value={form.blanketPoRef} onChange={(e) => set('blanketPoRef', e.target.value)} maxLength={20} />
        </Field>
        <Field label="Created at">
          <input className="field-input" type="datetime-local" value={form.createdAt} onChange={(e) => set('createdAt', e.target.value)} required />
        </Field>

        <Field label="Currency">
          <input className="field-input" value={form.currency} onChange={(e) => set('currency', e.target.value)} maxLength={3} />
        </Field>
        <Field label="Status">
          <select className="field-input" value={form.status} onChange={(e) => set('status', e.target.value)}>
            {CREATE_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </Field>
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input type="checkbox" checked={form.isEmergency} onChange={(e) => set('isEmergency', e.target.checked)} />
          Emergency purchase
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-slate-200 px-4 py-3">
        <span className="text-sm text-slate-600">Total: <strong className="tabular-nums">{inr(amount)}</strong></span>
        <button type="button" className="btn-secondary ml-auto" onClick={() => { setForm(blank()); setErrors([]); }} disabled={saving}>
          Clear
        </button>
        <button type="submit" className="btn-primary" disabled={saving || !masters}>
          {saving ? 'Saving…' : form.status === 'Draft' ? 'Save draft' : 'Submit requisition'}
        </button>
      </div>
    </form>
  );
}
