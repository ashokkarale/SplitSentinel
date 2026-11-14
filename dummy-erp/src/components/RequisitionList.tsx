import { useEffect, useState } from 'react';
import type { PaginationCursor } from '@uipath/uipath-typescript/core';
import type { Erp, PrPage } from '../lib/erp';
import { errorText } from '../lib/erp';
import type { Masters } from '../lib/pr';
import { inr, shortDate } from '../lib/pr';
import StatusBadge from './StatusBadge';

const PAGE_SIZE = 25;

interface Props {
  erp: Erp;
  masters: Masters | null;
  version: number;
}

export default function RequisitionList({ erp, masters, version }: Props) {
  // Cursor stack: cursors[i] fetches page i (cursors[0] is undefined = first page).
  const [cursors, setCursors] = useState<(PaginationCursor | undefined)[]>([undefined]);
  const [pageIndex, setPageIndex] = useState(0);
  const [page, setPage] = useState<PrPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // A new PR or import resets to the first page.
  useEffect(() => { setCursors([undefined]); setPageIndex(0); }, [version]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    erp.listPrs(PAGE_SIZE, cursors[pageIndex])
      .then((p) => {
        if (!alive) return;
        setPage(p);
        if (p.hasNextPage && cursors.length === pageIndex + 1) setCursors((c) => [...c, p.nextCursor]);
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erp, pageIndex, reload, version]);

  const from = page && page.items.length ? pageIndex * PAGE_SIZE + 1 : 0;
  const to = page ? pageIndex * PAGE_SIZE + page.items.length : 0;
  const name = (id: string) => masters?.employees.get(id)?.name ?? id;
  const vendor = (id: string) => masters?.vendors.get(id)?.name ?? id;

  return (
    <section className="panel">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 px-4 py-3">
        <h1 className="text-lg font-semibold">Purchase requisitions</h1>
        <span className="text-sm text-slate-500">
          {page ? `Showing ${from}–${to} of ${page.totalCount}` : ''}
        </span>
        <button type="button" className="btn-secondary ml-auto" onClick={() => setReload((r) => r + 1)} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error && <p className="px-4 py-3 text-sm text-red-700">Could not load requisitions: {error}</p>}

      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200">
          <thead className="bg-slate-50">
            <tr>
              <th className="th">PR</th>
              <th className="th">Created</th>
              <th className="th">Requester</th>
              <th className="th">Vendor</th>
              <th className="th">Description</th>
              <th className="th text-right">Amount</th>
              <th className="th">Status</th>
              <th className="th">Approval case</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {page?.items.map((p) => (
              <tr key={p.prId} className="hover:bg-slate-50">
                <td className="td font-mono whitespace-nowrap">{p.prId}</td>
                <td className="td whitespace-nowrap text-slate-600">{shortDate(p.createdAt)}</td>
                <td className="td">
                  <div className="max-w-[12rem] truncate" title={`${name(p.requesterId)} (${p.requesterId})`}>{name(p.requesterId)}</div>
                  <div className="text-xs text-slate-500">{p.costCenter}</div>
                </td>
                <td className="td"><div className="max-w-[12rem] truncate" title={vendor(p.vendorId)}>{vendor(p.vendorId)}</div></td>
                <td className="td"><div className="max-w-[22rem] truncate" title={p.description}>{p.description}</div></td>
                <td className="td text-right whitespace-nowrap tabular-nums">{inr(p.amount)}</td>
                <td className="td"><StatusBadge status={p.status} /></td>
                <td className="td font-mono text-xs whitespace-nowrap text-slate-600">{p.splitCaseId || '—'}</td>
              </tr>
            ))}
            {page && !page.items.length && !loading && (
              <tr><td className="td text-slate-500" colSpan={8}>No requisitions yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-slate-200 px-4 py-2">
        <button type="button" className="btn-secondary" onClick={() => setPageIndex((i) => i - 1)} disabled={loading || pageIndex === 0}>
          Previous
        </button>
        <span className="text-sm text-slate-600">Page {pageIndex + 1}</span>
        <button type="button" className="btn-secondary" onClick={() => setPageIndex((i) => i + 1)} disabled={loading || !page?.hasNextPage}>
          Next
        </button>
      </div>
    </section>
  );
}
