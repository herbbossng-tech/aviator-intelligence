import { Route, Routes } from 'react-router';
import { AppShell } from './components/AppShell';
import { AnalyticsPage } from './pages/analytics/AnalyticsPage';
import { DataSourcesPage } from './pages/DataSourcesPage';
import { MethodologyPage } from './pages/MethodologyPage';
import { NotFoundPage } from './pages/NotFoundPage';
import { OverviewPage } from './pages/OverviewPage';
import { BrowseRoundsPage } from './pages/rounds/BrowseRoundsPage';
import { ImportHistoryPage } from './pages/rounds/ImportHistoryPage';
import { ImportPage } from './pages/rounds/ImportPage';
import { ManualEntryPage } from './pages/rounds/ManualEntryPage';
import { RoundsLayout } from './pages/rounds/RoundsLayout';
import { SimulationDetailPage } from './pages/simulations/SimulationDetailPage';
import { UncertaintyPage } from './pages/simulations/UncertaintyPage';
import { SimulationsPage } from './pages/SimulationsPage';
import { StrategyLabPage } from './pages/StrategyLabPage';

export function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="rounds" element={<RoundsLayout />}>
          <Route index element={<BrowseRoundsPage />} />
          <Route path="new" element={<ManualEntryPage />} />
          <Route path="import" element={<ImportPage />} />
          <Route path="imports" element={<ImportHistoryPage />} />
        </Route>
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="strategy-lab" element={<StrategyLabPage />} />
        <Route path="simulations" element={<SimulationsPage />} />
        <Route path="simulations/:id" element={<SimulationDetailPage />} />
        <Route path="simulations/:id/uncertainty" element={<UncertaintyPage />} />
        <Route path="data-sources" element={<DataSourcesPage />} />
        <Route path="methodology" element={<MethodologyPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
