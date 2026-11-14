const TONES: Record<string, string> = {
  Draft: 'bg-slate-100 text-slate-700',
  Submitted: 'bg-sky-100 text-sky-800',
  UnderReview: 'bg-amber-100 text-amber-800',
  OnHold: 'bg-orange-100 text-orange-800',
  Unverified: 'bg-orange-100 text-orange-800',
  Released: 'bg-emerald-100 text-emerald-800',
  Consolidated: 'bg-violet-100 text-violet-800',
  Rejected: 'bg-red-100 text-red-800',
};

export default function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-xs font-medium ${TONES[status] ?? 'bg-slate-100 text-slate-700'}`}>
      {status || '—'}
    </span>
  );
}
