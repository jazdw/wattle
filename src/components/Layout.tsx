import { ChartPie, Grid3x3, Landmark, LayoutDashboard, LineChart, List, LogOut, Menu, Settings, X } from 'lucide-react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { Suspense, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useConnections } from '../hooks/queries';
import { StatusBanner } from './StatusBanner';
import { useAuth } from '../hooks/useAuth';
import { cn } from '../lib/utils';
import { Avatar } from './ui/misc';
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
  return <img src="/logo.svg" alt="" className={cn('size-8 rounded-lg', className)} />;
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <Logo />
      <span className="text-lg font-semibold tracking-tight">Wattle Wealth</span>
    </div>
  );
}

/** The page links, the currency switch and who is signed in: the desktop sidebar, and the phone menu. */
function NavPanel({ onNavigate }: { onNavigate?: () => void }) {
  const { me, currency, setCurrency, logout } = useAuth();
  const connections = useConnections();
  // A disconnected login was set aside on purpose; it needs nothing.
  const broken = connections.data?.connections.filter((connection) => connection.status !== 'ok' && connection.status !== 'disconnected') ?? [];

  return (
    <>
      <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink
            key={to}
            to={to}
            end={end}
            onClick={onNavigate}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-2.5 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground md:py-1.5',
                isActive && 'bg-muted font-medium text-foreground',
              )
            }
          >
            <Icon className="size-4" />
            <span>{label}</span>
            {to === '/accounts' && broken.length > 0 && <span className="size-2 rounded-full bg-negative" />}
          </NavLink>
        ))}
      </nav>
      <div className="flex flex-col items-stretch gap-3">
        <Segmented
          value={currency}
          options={[
            { value: 'USD', label: 'USD' },
            { value: 'AUD', label: 'AUD' },
          ]}
          onChange={setCurrency}
        />
        {me && (
          <div className="flex min-w-0 items-center gap-2 border-t px-2 pt-3" title={`Signed in as ${me.user.email}`}>
            <Avatar name={me.user.name} picture={me.user.picture} className="size-7 text-xs" />
            <div className="min-w-0 text-xs">
              <p className="truncate font-medium">{me.user.name}</p>
              <p className="truncate text-muted-foreground">{me.user.email}</p>
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => void logout()}
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-muted"
        >
          <LogOut className="size-4" />
          <span>Sign out</span>
        </button>
      </div>
    </>
  );
}

/** Below md: a top bar whose menu button slides the panel in from the left. */
function PhoneBar() {
  const [open, setOpen] = useState(false);
  const connections = useConnections();
  const broken = connections.data?.connections.some((connection) => connection.status !== 'ok' && connection.status !== 'disconnected') ?? false;

  return (
    <header className="sticky top-0 z-30 flex items-center gap-2 border-b bg-card/90 px-2 py-2 backdrop-blur md:hidden">
      <DialogPrimitive.Root open={open} onOpenChange={setOpen}>
        <DialogPrimitive.Trigger className="relative rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Menu">
          <Menu className="size-5" />
          {broken && <span className="absolute right-1.5 top-1.5 size-2 rounded-full bg-negative" />}
        </DialogPrimitive.Trigger>
        <DialogPrimitive.Portal>
          <DialogPrimitive.Overlay className="fade-in fixed inset-0 z-50 bg-black/40 backdrop-blur-[1px]" />
          <DialogPrimitive.Content className="drawer-in fixed inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] flex-col gap-4 border-r bg-card px-3 py-4 shadow-lg">
            <DialogPrimitive.Title className="sr-only">Menu</DialogPrimitive.Title>
            <DialogPrimitive.Description className="sr-only">Pages, currency and sign out</DialogPrimitive.Description>
            <div className="flex items-center justify-between px-2">
              <Brand />
              <DialogPrimitive.Close className="rounded-sm p-1 opacity-70 hover:opacity-100" aria-label="Close menu">
                <X className="size-4" />
              </DialogPrimitive.Close>
            </div>
            <NavPanel onNavigate={() => setOpen(false)} />
          </DialogPrimitive.Content>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <Brand />
    </header>
  );
}

export function Layout() {
  return (
    <div className="min-h-screen md:grid md:grid-cols-[13rem_1fr]">
      <PhoneBar />
      <aside className="sticky top-0 hidden h-screen flex-col gap-4 border-r bg-card/90 px-3 py-4 backdrop-blur md:flex">
        <div className="px-2">
          <Brand />
        </div>
        <NavPanel />
      </aside>
      <main className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6 sm:py-8">
        <StatusBanner />
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
