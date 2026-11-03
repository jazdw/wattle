import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { HistoryWatcher } from './components/HistoryWatcher';
import { ImportWatcher } from './components/ImportWatcher';
import { Layout } from './components/Layout';
import { useAuth } from './hooks/useAuth';
import { Login } from './pages/Login';
import { NetWorth } from './pages/NetWorth';
import { Growth } from './pages/Growth';
import { Allocation } from './pages/Allocation';
import { Holdings } from './pages/Holdings';
import { Transactions } from './pages/Transactions';
import { Style } from './pages/Style';
import { Accounts } from './pages/Accounts';
import { Import } from './pages/Import';
import { Settings } from './pages/Settings';
import { Activity } from './pages/Activity';
import { PlaidOAuth } from './pages/PlaidOAuth';

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
            <HistoryWatcher />
            <ImportWatcher />
            <Layout />
          </RequireAuth>
        }
      >
        <Route index element={<NetWorth />} />
        <Route path="growth" element={<Growth />} />
        <Route path="allocation" element={<Allocation />} />
        <Route path="holdings" element={<Holdings />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="style" element={<Style />} />
        <Route path="accounts" element={<Accounts />} />
        <Route path="import" element={<Import />} />
        <Route path="settings" element={<Settings />} />
        <Route path="activity" element={<Activity />} />
        <Route path="plaid-oauth" element={<PlaidOAuth />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
