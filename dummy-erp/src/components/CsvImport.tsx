import { useState } from 'react';
import type { ChangeEvent } from 'react';
import Papa from 'papaparse';
import type { Erp } from '../lib/erp';
import { errorText } from '../lib/erp';
import type { Checked, Masters, RawRow } from '../lib/pr';
import { CSV_COLUMNS, checkPr, csvTemplate, inr } from '../lib/pr';

interface Props {
  erp: Erp;
  masters: Masters | null;
  prIds: Set<string>;
  onCreated: () => Promise<void>;
}

type RowState = Checked & { line: number; result?: 'created' | 'failed'; message?: string };

const MAX_ROWS = 500;

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([csvTemplate()], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'purchase-requisitions-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export default function CsvImport({ erp, masters, prIds, onCreated }: Props) {
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<RowState[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [done, setDone] = useState(0);

  const valid = rows.filter((r) => r.pr && !r.result);
  const invalid = rows.filter((r) => !r.pr);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !masters) return;
    setFileName(file.name);
    setProblem(null);
    setRows([]);
    setDone(0);
    Papa.parse<RawRow>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      transformHeader: (h) => h.trim(),
      complete: (res) => {
        const headers = res.meta.fields ?? [];
        const missing = ['prId', 'requesterId', 'vendorId', 'description'].filter((c) => !headers.includes(c));
        if (missing.length) {
          setProblem(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template's header row.`);
          return;
        }
        if (res.data.length > MAX_ROWS) {
          setProblem(`The file has ${res.data.length} rows; import at most ${MAX_ROWS} at a time.`);
          return;
        }
        const unknown = headers.filter((h) => !(CSV_COLUMNS as readonly string[]).includes(h) && h !== 'splitCaseId');
        // Each row is checked against existing PR numbers and the rows above it.
        const seen = new Set(prIds);
        const checked = res.data.map((raw, i) => {
          const c = checkPr(raw, masters, seen);
          if (c.pr) seen.add(c.pr.prId);
          if (i === 0 && unknown.length) c.warnings.push(`Ignored column${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`);
          return { ...c, line: i + 2 };
        });
        setRows(checked);
      },
      error: (err) => setProblem(`Could not read the file: ${err.message}`),
    });
  };

  // One insert per row, in file order: each new PR raises its own record-created event.
  const runImport = async () => {
    setImporting(true);
    let count = 0;
    for (const row of rows) {
      if (!row.pr || row.result) continue;
      try {
        await erp.createPr(row.pr);
        row.result = 'created';
      } catch (err) {
        row.result = 'failed';
        row.message = errorText(err);
      }
      count++;
      setDone(count);
      setRows((r) => [...r]);
    }
    setImporting(false);
    await onCreated();
  };

  const createdCount = rows.filter((r) => r.result === 'created').length;
  const failedCount = rows.filter((r) => r.result === 'failed').length;

  return (
    <section className="space-y-4">
      <div className="panel p-4">
        <h1 className="text-lg font-semibold">Import requisitions from CSV</h1>
        <p className="mt-1 text-sm text-slate-600">
          One row per requisition, with the same columns as the requisition record. Rows are checked first; only valid rows are imported,
          one at a time in file order. Leave <code>amount</code> empty to use quantity × unit price, <code>status</code> empty for Submitted
          and <code>createdAt</code> empty for now.
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button type="button" className="btn-secondary" onClick={downloadTemplate}>Download template</button>
          <label className={`btn-primary ${!masters || importing ? 'pointer-events-none opacity-50' : 'cursor-pointer'}`}>
            Choose CSV file
            <input type="file" accept=".csv,text/csv" className="sr-only" onChange={onFile} disabled={!masters || importing} />
          </label>
          {fileName && <span className="max-w-full truncate text-sm text-slate-600">{fileName}</span>}
        </div>
        <p className="mt-3 text-xs text-slate-500 break-words">Columns: {CSV_COLUMNS.join(', ')}</p>
        {problem && <p className="mt-3 text-sm text-red-700">{problem}</p>}
      </div>

      {rows.length > 0 && (
        <div className="panel">
          <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3 text-sm">
            <span><strong>{rows.length}</strong> rows</span>
            <span className="text-emerald-700">{rows.length - invalid.length} valid</span>
            {invalid.length > 0 && <span className="text-red-700">{invalid.length} with errors (skipped)</span>}
            {(createdCount > 0 || failedCount > 0) && (
              <span className="text-slate-700">Imported {createdCount}{failedCount ? `, ${failedCount} failed` : ''}</span>
            )}
            <button type="button" className="btn-primary ml-auto" onClick={runImport} disabled={importing || valid.length === 0}>
              {importing ? `Importing ${done}/${rows.length - invalid.length}…` : `Import ${valid.length} requisition${valid.length === 1 ? '' : 's'}`}
            </button>
          </div>
          <div className="max-h-[32rem] overflow-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="sticky top-0 bg-slate-50">
                <tr>
                  <th className="th">Line</th>
                  <th className="th">PR</th>
                  <th className="th">Requester</th>
                  <th className="th">Vendor</th>
                  <th className="th">Description</th>
                  <th className="th text-right">Amount</th>
                  <th className="th">Check</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r) => (
                  <tr key={r.line} className={!r.pr ? 'bg-red-50/60' : r.result === 'failed' ? 'bg-red-50/60' : ''}>
                    <td className="td text-slate-500">{r.line}</td>
                    <td className="td font-mono whitespace-nowrap">{r.pr?.prId ?? '—'}</td>
                    <td className="td whitespace-nowrap">{r.pr ? `${masters?.employees.get(r.pr.requesterId)?.name ?? r.pr.requesterId}` : '—'}</td>
                    <td className="td"><div className="max-w-[10rem] truncate">{r.pr ? masters?.vendors.get(r.pr.vendorId)?.name ?? r.pr.vendorId : '—'}</div></td>
                    <td className="td"><div className="max-w-[18rem] truncate" title={r.pr?.description}>{r.pr?.description ?? ''}</div></td>
                    <td className="td text-right tabular-nums whitespace-nowrap">{r.pr ? inr(r.pr.amount) : ''}</td>
                    <td className="td text-xs">
                      {r.result === 'created' && <span className="font-medium text-emerald-700">Created</span>}
                      {r.result === 'failed' && <span className="text-red-700 break-words">Failed: {r.message}</span>}
                      {!r.result && r.pr && !r.warnings.length && <span className="text-emerald-700">Ready</span>}
                      {r.errors.map((m) => <div key={m} className="text-red-700 break-words">{m}</div>)}
                      {r.warnings.map((m) => <div key={m} className="text-amber-700 break-words">{m}</div>)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  );
}
