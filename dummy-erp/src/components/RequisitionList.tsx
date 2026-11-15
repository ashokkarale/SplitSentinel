import { useCallback, useEffect, useRef, useState } from 'react';
import type { PaginationCursor } from '@uipath/uipath-typescript/core';
import type { Erp, PrPage, PrSort } from '../lib/erp';
import { DEFAULT_SORT } from '../lib/erp';
import { errorText } from '../lib/erp';
import type { Masters } from '../lib/pr';
import { inr } from '../lib/pr';
import StatusBadge from './StatusBadge';

const PAGE_SIZE = 25;

// Date on one line, time below it: keeps the column narrow.
function dateParts(iso: string) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return { day: iso, time: '' };
  const d = new Date(t);
  return {
    day: d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }),
    time: d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
  };
}

function SortHeader({ label, field, sort, onSort, align, className = '', title }: {
  label: string;
  field: PrSort['field'];
  sort: PrSort;
  onSort: (f: PrSort['field']) => void;
  align?: 'right';
  className?: string;
  title?: string;
}) {
  const active = sort.field === field;
  return (
    <th className={`th ${className}`} aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'} title={title}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={`group/sort inline-flex w-full items-center gap-1 uppercase tracking-wide hover:text-slate-800 ${align === 'right' ? 'justify-end' : ''} ${active ? 'text-slate-800' : ''}`}
      >
        {label}
        <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true"
          className={`shrink-0 transition ${active ? 'opacity-100' : 'opacity-0 group-hover/sort:opacity-40'} ${active && !sort.desc ? 'rotate-180' : ''}`}>
          <path d="M6 9 2.5 4.5h7L6 9Z" fill="currentColor" />
        </svg>
      </button>
    </th>
  );
}

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
  const [sort, setSort] = useState<PrSort>(DEFAULT_SORT);

  // First click: A to Z for text, newest/largest first for dates and amounts; a second click flips it.
  const sortBy = (field: PrSort['field']) => {
    setSort((s) => (s.field === field ? { field, desc: !s.desc } : { field, desc: field === 'createdAt' || field === 'amount' }));
    setCursors([undefined]);
    setPageIndex(0);
  };
  // Edge fades show there is more table to scroll to (only on narrow screens).
  const scroller = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setEdges({ left: el.scrollLeft > 2, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 2 });
  }, []);
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, page]);

  // A new PR or import resets to the first page.
  useEffect(() => { setCursors([undefined]); setPageIndex(0); }, [version]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    erp.listPrs(PAGE_SIZE, cursors[pageIndex], sort)
      .then((p) => {
        if (!alive) return;
        setPage(p);
        if (p.hasNextPage && cursors.length === pageIndex + 1) setCursors((c) => [...c, p.nextCursor]);
      })
      .catch((e) => alive && setError(errorText(e)))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erp, pageIndex, reload, version, sort]);

  const from = page && page.items.length ? pageIndex * PAGE_SIZE + 1 : 0;
  const to = page ? pageIndex * PAGE_SIZE + page.items.length : 0;
  const name = (id: string) => masters?.employees.get(id)?.name ?? id;
  const vendor = (id: string) => masters?.vendors.get(id)?.name ?? id;

  return (
    <section className="panel overflow-hidden">
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

      <div className="relative">
        <div ref={scroller} onScroll={measure} className="overflow-x-auto">
          <table className="w-full min-w-[960px] table-fixed">
            <colgroup>
              <col className="w-[6.5rem]" />
              <col className="w-[7.5rem]" />
              <col className="w-[10rem]" />
              <col className="w-[10rem]" />
              <col />
              <col className="w-[7rem]" />
              <col className="w-[8rem]" />
              <col className="w-[7.5rem]" />
            </colgroup>
            <thead className="border-b border-slate-200 bg-slate-50">
              <tr>
                <SortHeader label="PR" field="prId" sort={sort} onSort={sortBy} className="sticky left-0 z-10 bg-slate-50" />
                <SortHeader label="Created" field="createdAt" sort={sort} onSort={sortBy} />
                <th className="th">Requester</th>
                <th className="th">Vendor</th>
                <SortHeader label="Description" field="description" sort={sort} onSort={sortBy} />
                <SortHeader label="Amount" field="amount" sort={sort} onSort={sortBy} align="right" />
                <SortHeader label="Status" field="status" sort={sort} onSort={sortBy} />
                <SortHeader label="Case" field="splitCaseId" sort={sort} onSort={sortBy} title="SplitSentinel case that checked this PR" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {page?.items.map((p) => {
                const when = dateParts(p.createdAt);
                return (
                  <tr key={p.prId} className="group hover:bg-slate-50">
                    <td className="td sticky left-0 z-10 bg-white font-mono font-medium group-hover:bg-slate-50">{p.prId}</td>
                    <td className="td">
                      <div className="whitespace-nowrap">{when.day}</div>
                      <div className="text-xs text-slate-500">{when.time}</div>
                    </td>
                    <td className="td">
                      <div className="truncate" title={`${name(p.requesterId)} (${p.requesterId})`}>{name(p.requesterId)}</div>
                      <div className="text-xs text-slate-500">{p.costCenter}</div>
                    </td>
                    <td className="td">
                      <div className="truncate" title={vendor(p.vendorId)}>{vendor(p.vendorId)}</div>
                      <div className="truncate text-xs text-slate-500">{p.category}</div>
                    </td>
                    <td className="td">
                      <div className="line-clamp-2 break-words" title={p.description}>{p.description}</div>
                    </td>
                    <td className="td text-right whitespace-nowrap font-medium tabular-nums">{inr(p.amount)}</td>
                    <td className="td"><StatusBadge status={p.status} /></td>
                    <td className="td font-mono text-xs whitespace-nowrap text-slate-600">
                      <div className="truncate" title={p.splitCaseId ?? undefined}>{p.splitCaseId || '—'}</div>
                    </td>
                  </tr>
                );
              })}
              {page && !page.items.length && !loading && (
                <tr><td className="td py-10 text-center text-slate-500" colSpan={8}>No requisitions yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
        {edges.left && <div className="pointer-events-none absolute inset-y-0 left-[6.5rem] w-6 bg-gradient-to-r from-slate-900/10 to-transparent" aria-hidden="true" />}
        {edges.right && <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-slate-900/10 to-transparent" aria-hidden="true" />}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 bg-slate-50 px-4 py-2.5">
        <span className="mr-auto text-sm text-slate-600">
          {page && page.totalCount ? `${from}–${to} of ${page.totalCount} requisitions` : ''}
        </span>
        <button type="button" className="btn-secondary" onClick={() => setPageIndex((i) => i - 1)} disabled={loading || pageIndex === 0}>
          Previous
        </button>
        <span className="px-1 text-sm text-slate-600">Page {pageIndex + 1}{page && page.totalCount ? ` of ${Math.max(1, Math.ceil(page.totalCount / PAGE_SIZE))}` : ''}</span>
        <button type="button" className="btn-secondary" onClick={() => setPageIndex((i) => i + 1)} disabled={loading || !page?.hasNextPage}>
          Next
        </button>
      </div>
    </section>
  );
}
