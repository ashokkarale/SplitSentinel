import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthProvider, useAuth } from './hooks/useAuth';
import { createErp, errorText } from './lib/erp';
import type { Masters } from './lib/pr';
import RequisitionList from './components/RequisitionList';
import NewRequisition from './components/NewRequisition';
import CsvImport from './components/CsvImport';

type Tab = 'list' | 'new' | 'import';

const TABS: { id: Tab; label: string }[] = [
  { id: 'list', label: 'Requisitions' },
  { id: 'new', label: 'New requisition' },
  { id: 'import', label: 'Import CSV' },
];

function Shell() {
  const { sdk, logout } = useAuth();
  const erp = useMemo(() => createErp(sdk), [sdk]);
  const [tab, setTab] = useState<Tab>('list');
  const [masters, setMasters] = useState<Masters | null>(null);
  const [prIds, setPrIds] = useState<Set<string>>(new Set());
  const [loadError, setLoadError] = useState<string | null>(null);
  const [listVersion, setListVersion] = useState(0);

  const refreshIds = useCallback(async () => {
    setPrIds(await erp.loadPrIds());
  }, [erp]);

  useEffect(() => {
    Promise.all([erp.loadMasters(), erp.loadPrIds()])
      .then(([m, ids]) => { setMasters(m); setPrIds(ids); })
      .catch((e) => setLoadError(errorText(e)));
  }, [erp]);

  // After a create or import: refresh the duplicate check and the list.
  const onCreated = useCallback(async () => {
    await refreshIds();
    setListVersion((v) => v + 1);
  }, [refreshIds]);

  return (
    <div className="min-h-screen flex flex-col">
      <header className="bg-slate-800 text-white">
        <div className="mx-auto max-w-6xl px-4 flex flex-wrap items-center gap-x-6 gap-y-2 py-2">
          <div className="flex items-center gap-2 py-1">
            <span className="grid h-7 w-7 place-items-center rounded bg-brand-600 text-sm font-bold">O</span>
            <span className="font-semibold tracking-tight">Open ERP</span>
            <span className="hidden sm:inline text-slate-400 text-sm">· Procurement</span>
          </div>
          <nav className="flex flex-wrap gap-1" aria-label="Sections">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded px-3 py-1.5 text-sm ${tab === t.id ? 'bg-slate-600 text-white' : 'text-slate-300 hover:bg-slate-700'}`}
                aria-current={tab === t.id ? 'page' : undefined}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <button type="button" onClick={logout} className="ml-auto text-sm text-slate-300 hover:text-white">
            Sign out
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6">
        {loadError && (
          <div className="panel mb-4 border-red-200 bg-red-50 p-3 text-sm text-red-800">
            Could not load employees, vendors or PR numbers: {loadError}
          </div>
        )}
        {tab === 'list' && <RequisitionList erp={erp} masters={masters} version={listVersion} />}
        {tab === 'new' && (
          <NewRequisition erp={erp} masters={masters} prIds={prIds} onCreated={onCreated} onShowList={() => setTab('list')} />
        )}
        {tab === 'import' && <CsvImport erp={erp} masters={masters} prIds={prIds} onCreated={onCreated} />}
      </main>

      <footer className="py-3 text-center text-xs text-slate-400">Open ERP · demo procurement system</footer>
    </div>
  );
}

function AppContent() {
  const { isAuthenticated, isLoading, error, login } = useAuth();

  if (isLoading) return <div className="p-8 text-slate-500">Loading…</div>;

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen grid place-items-center bg-slate-100 px-4">
        <div className="panel w-full max-w-sm p-8 text-center">
          <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded bg-brand-600 text-lg font-bold text-white">O</div>
          <h1 className="text-xl font-semibold">Open ERP</h1>
          <p className="mt-1 mb-6 text-sm text-slate-600">Purchase requisitions</p>
          {error && <p className="mb-4 text-sm text-red-700">{error}</p>}
          <button type="button" onClick={login} className="btn-primary w-full">Sign in</button>
        </div>
      </div>
    );
  }
  return <Shell />;
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
