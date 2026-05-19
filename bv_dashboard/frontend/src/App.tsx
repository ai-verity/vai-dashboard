// App.tsx
import { useEffect, useState } from 'react';
import TopNav      from './components/TopNav';
import KpiStrip    from './components/KpiStrip';
import AlertTicker from './components/AlertTicker';
import DashboardPage from './pages/DashboardPage';
import ChartsPage    from './pages/ChartsPage';
import VlmPage       from './pages/VlmPage';
import AiMetricsPage from './pages/AiMetricsPage';
import { IncidentsProvider } from './hooks/IncidentsProvider';

type View = 'dashboard' | 'charts' | 'vlm';

// Hash-routing: `#/ai-metrics` swaps the entire app shell out for the
// standalone AI Model Metrics dashboard. Keeps the existing tab-based
// navigation untouched for everything else.
function useHashRoute(): string {
  const [hash, setHash] = useState<string>(() => window.location.hash);
  useEffect(() => {
    const onChange = () => setHash(window.location.hash);
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return hash;
}

export default function App() {
  const [view, setView] = useState<View>('dashboard');
  const hash = useHashRoute();

  if (hash === '#/ai-metrics') {
    return <AiMetricsPage />;
  }

  // Dashboard and Charts read the same `/api/incidents` data via context
  // so the three Dashboard consumers (Ticker, Feed, Map) share one fetch.
  // VLM doesn't use it, but mounting the provider unconditionally keeps
  // the working set warm if the user switches back.
  return (
    <IncidentsProvider>
      <TopNav activeView={view} onViewChange={setView} />
      {view !== 'vlm' && <KpiStrip />}
      {view !== 'vlm' && <AlertTicker />}
      {view === 'dashboard' && <DashboardPage />}
      {view === 'charts' && <ChartsPage />}
      {view === 'vlm' && <VlmPage />}
    </IncidentsProvider>
  );
}
