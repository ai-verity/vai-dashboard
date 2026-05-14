// App.tsx
import { useState } from 'react';
import TopNav      from './components/TopNav';
import KpiStrip    from './components/KpiStrip';
import AlertTicker from './components/AlertTicker';
import DashboardPage from './pages/DashboardPage';
import ChartsPage    from './pages/ChartsPage';
import VlmPage       from './pages/VlmPage';
import { IncidentsProvider } from './hooks/IncidentsProvider';

type View = 'dashboard' | 'charts' | 'vlm';

export default function App() {
  const [view, setView] = useState<View>('dashboard');

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
