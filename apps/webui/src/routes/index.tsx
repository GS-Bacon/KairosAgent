import { Routes, Route, Navigate } from 'react-router-dom';
import { DailyReportsPage } from '../pages/DailyReportsPage';
import { CyclesPage } from '../pages/CyclesPage';
import { CycleDetailPage } from '../pages/CycleDetailPage';
import { QueuesPage } from '../pages/QueuesPage';

export function AppRoutes() {
  return (
    <Routes>
      <Route path="/" element={<Navigate to="/cycles" replace />} />
      <Route path="/daily-reports" element={<DailyReportsPage />} />
      <Route path="/cycles" element={<CyclesPage />} />
      <Route path="/cycles/:cycleId" element={<CycleDetailPage />} />
      <Route path="/queues" element={<QueuesPage />} />
    </Routes>
  );
}
