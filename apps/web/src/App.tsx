import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { DataSourcesPage } from './pages/DataSourcesPage';
import { MethodologyPage } from './pages/MethodologyPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { RoundsPage } from './pages/RoundsPage';
import { SimulationsPage } from './pages/SimulationsPage';
import { StrategyLabPage } from './pages/StrategyLabPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="rounds" element={<RoundsPage />} />
        <Route path="strategy-lab" element={<StrategyLabPage />} />
        <Route path="simulations" element={<SimulationsPage />} />
        <Route path="data-sources" element={<DataSourcesPage />} />
        <Route path="methodology" element={<MethodologyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
