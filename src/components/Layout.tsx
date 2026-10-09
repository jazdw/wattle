import { useQuery } from '@tanstack/react-query';
import { ChartPie, Grid3x3, Landmark, LayoutDashboard, LineChart, List, LogOut, Settings } from 'lucide-react';
import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import type { ConnectionsResponse } from '../../shared/types';
import { api } from '../api';
import { useAuth } from '../hooks/useAuth';
import { cn } from '../lib/utils';
import { Segmented } from './ui/segmented';

const NAV = [
  { to: '/', label: 'Net worth', icon: LayoutDashboard, end: true },
  { to: '/growth', label: 'Growth', icon: LineChart },
  { to: '/allocation', label: 'Allocation', icon: ChartPie },
  { to: '/holdings', label: 'Holdings', icon: List },
  { to: '/style', label: 'Style', icon: Grid3x3 },
  { to: '/accounts', label: 'Accounts', icon: Landmark },
  { to: '/settings', label: 'Settings', icon: Settings },
];

export function Logo({ className }: { className?: string }) {
  return <img src="/favicon.svg" alt="" className={cn('size-8 rounded-lg', className)} />;
}

export function Layout() {
  const { me, currency, setCurrency, logout } = useAuth();
  const connections = useQuery({
    queryKey: ['connections'],
    queryFn: () => api<ConnectionsResponse>('/api/connections'),
  });
  const broken = connections.data?.connections.filter((connection) => connection.status !== 'ok') ?? [];

  return (
    <div className="min-h-screen md:grid md:grid-cols-[13rem_1fr]">
      <aside className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/90 px-3 py-2 backdrop-blur md:h-screen md:flex-col md:items-stretch md:border-b-0 md:border-r md:px-3 md:py-4">
        <div className="flex items-center gap-2 md:mb-4 md:px-2">
          <Logo />
          <span className="text-lg font-semibold tracking-tight">Wattle</span>
        </div>
        <nav className="flex flex-1 gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          {NAV.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground',
                  isActive && 'bg-muted font-medium text-foreground',
                )
              }
            >
              <Icon className="size-4" />
              <span className="hidden sm:inline">{label}</span>
              {to === '/accounts' && broken.length > 0 && <span className="size-2 rounded-full bg-negative" />}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2 md:flex-col md:items-stretch md:gap-3">
          <Segmented
            value={currency}
            options={[
              { value: 'USD', label: 'USD' },
              { value: 'AUD', label: 'AUD' },
            ]}
            onChange={setCurrency}
          />
          <button
            type="button"
            onClick={() => void logout()}
            className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
            title={me ? `Signed in as ${me.user.email}` : undefined}
          >
            <LogOut className="size-4" />
            <span className="hidden md:inline">Sign out</span>
          </button>
        </div>
      </aside>
      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <Suspense fallback={<div className="h-96 animate-pulse rounded-lg bg-muted" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
