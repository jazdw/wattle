import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Layout } from './components/Layout';
import { Skeleton } from './components/ui/misc';
import { useAuth } from './hooks/useAuth';
import { Login } from './pages/Login';

// Pages (and Recharts) load on demand to keep the first load small.
const NetWorth = lazy(() => import('./pages/NetWorth').then((module) => ({ default: module.NetWorth })));
const Growth = lazy(() => import('./pages/Growth').then((module) => ({ default: module.Growth })));
const Allocation = lazy(() => import('./pages/Allocation').then((module) => ({ default: module.Allocation })));
const Holdings = lazy(() => import('./pages/Holdings').then((module) => ({ default: module.Holdings })));
const Style = lazy(() => import('./pages/Style').then((module) => ({ default: module.Style })));
const Accounts = lazy(() => import('./pages/Accounts').then((module) => ({ default: module.Accounts })));
const Settings = lazy(() => import('./pages/Settings').then((module) => ({ default: module.Settings })));

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { me, loading } = useAuth();
  const location = useLocation();
  if (loading) return null;
  if (!me) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <Suspense fallback={<Skeleton className="m-8 h-96" />}>
              <Layout />
            </Suspense>
          </RequireAuth>
        }
      >
        <Route index element={<NetWorth />} />
        <Route path="growth" element={<Growth />} />
        <Route path="allocation" element={<Allocation />} />
        <Route path="holdings" element={<Holdings />} />
        <Route path="style" element={<Style />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="settings" element={<Settings />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
