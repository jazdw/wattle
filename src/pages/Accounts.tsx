import { useMutation, useQueryClient } from '@tanstack/react-query';
import { EyeOff, Layers, Pencil, Plus, RefreshCw, Upload } from 'lucide-react';
import { useState } from 'react';
import type { AccountSummary, ConnectionSummary } from '../../shared/types';
import { api } from '../api';
import { EditAccountDialog, HoldingsDialog, ImportDialog, NewAccountDialog } from '../components/AccountDialogs';
import { PageHeader } from '../components/Layout';
import { PlaidLinkButton } from '../components/PlaidLinkButton';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Alert, Skeleton } from '../components/ui/misc';
import { useAccounts, useConnections } from '../hooks/queries';
import { useAuth, useOwnerName } from '../hooks/useAuth';
import { money, relativeTime } from '../lib/format';

const STATUS_TEXT: Record<ConnectionSummary['status'], string> = {
  ok: 'Connected',
  login_required: 'Sign-in needed',
  pending_expiration: 'Consent expiring',
  error: 'Error',
  removed: 'Removed',
};

const BACKFILL_TEXT: Record<ConnectionSummary['backfillStatus'], string | null> = {
  pending: 'History pending',
  running: 'Loading history…',
  done: null,
  failed: 'History unavailable',
  skipped: 'No history from bank — import a CSV',
};

/** Plaid's Trial plan allows 10 production Items, and removed ones still count. */
const TRIAL_ITEM_LIMIT = 10;

export function Accounts() {
  const { currency } = useAuth();
  const ownerName = useOwnerName();
  const queryClient = useQueryClient();
  const connections = useConnections();
  const accounts = useAccounts();
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [editing, setEditing] = useState<AccountSummary | null>(null);
  const [holdingsFor, setHoldingsFor] = useState<AccountSummary | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  const sync = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}/sync`, { method: 'POST' }),
    onSuccess: () => void queryClient.invalidateQueries(),
    onError: (caught) => setError(caught.message),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/connections/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setRemoving(null);
      void queryClient.invalidateQueries();
    },
    onError: (caught) => setError(caught.message),
  });

  const accountsBy = (connectionId: string | null) =>
    (accounts.data?.accounts ?? []).filter((account) => account.connectionId === connectionId);
  const manual = (accounts.data?.accounts ?? []).filter((account) => account.source === 'manual');
  const production = connections.data?.plaidEnv === 'production';

  return (
    <>
      <PageHeader
        title="Accounts"
        description="Each of you links your own logins. Hide duplicates of joint accounts so they're only counted once."
        actions={
          <>
            {connections.data?.plaidEnv && (
              <>
                <PlaidLinkButton kind="investments" label="Link investments" onError={setError} />
                <PlaidLinkButton kind="banking" label="Link bank / card" variant="outline" onError={setError} />
              </>
            )}
            <Button variant="outline" onClick={() => setCreating(true)}>
              <Plus /> Manual account
            </Button>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Upload /> Import CSV
            </Button>
          </>
        }
      />

      {error && (
        <div className="mb-4">
          <Alert variant="error">{error}</Alert>
        </div>
      )}
      {connections.data && !connections.data.plaidEnv && (
        <div className="mb-4">
          <Alert variant="warning">Plaid isn't configured on the server; only manual accounts are available.</Alert>
        </div>
      )}
      {connections.data?.plaidEnv === 'sandbox' && (
        <div className="mb-4">
          <Alert>
            Plaid <strong>sandbox</strong>: use username <code>user_good</code> / password <code>pass_good</code>. No real data.
          </Alert>
        </div>
      )}

      <div className="grid gap-4">
        {connections.isPending || accounts.isPending ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          connections.data?.connections.map((connection) => (
            <Card key={connection.id}>
              <CardHeader className="flex-row flex-wrap items-start justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    {connection.institutionName ?? 'Institution'}
                    <Badge variant={connection.status === 'ok' ? 'outline' : 'danger'}>{STATUS_TEXT[connection.status]}</Badge>
                    {BACKFILL_TEXT[connection.backfillStatus] && <Badge variant="outline">{BACKFILL_TEXT[connection.backfillStatus]}</Badge>}
                  </CardTitle>
                  <CardDescription>
                    Linked by {ownerName(connection.ownerUserId)} · {connection.kind === 'investments' ? 'Investments' : 'Banking'} · synced{' '}
                    {relativeTime(connection.lastSyncedAt)}
                  </CardDescription>
                </div>
                <div className="flex flex-wrap gap-2">
                  {connection.status !== 'ok' && (
                    <PlaidLinkButton kind={connection.kind} connectionId={connection.id} label="Fix connection" variant="accent" size="sm" onError={setError} />
                  )}
                  <Button variant="outline" size="sm" onClick={() => sync.mutate(connection.id)} disabled={sync.isPending}>
                    <RefreshCw className={sync.isPending && sync.variables === connection.id ? 'animate-spin' : undefined} /> Sync
                  </Button>
                  {removing === connection.id ? (
                    <Button variant="destructive" size="sm" onClick={() => remove.mutate(connection.id)} disabled={remove.isPending}>
                      Confirm disconnect
                    </Button>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setRemoving(connection.id)}>
                      Disconnect
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent>
                {removing === connection.id && (
                  <p className="mb-2 text-xs text-muted-foreground">
                    Disconnecting stops syncing. Its accounts and history are kept as manual accounts.
                    {production && ' On the Plaid Trial plan the slot is not freed.'}
                  </p>
                )}
                <AccountList
                  accounts={accountsBy(connection.id)}
                  currency={currency}
                  ownerName={ownerName}
                  onEdit={setEditing}
                />
              </CardContent>
            </Card>
          ))
        )}

        {manual.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Manual accounts</CardTitle>
              <CardDescription>Update balances from statements, or track holdings by ticker.</CardDescription>
            </CardHeader>
            <CardContent>
              <AccountList
                accounts={manual}
                currency={currency}
                ownerName={ownerName}
                onEdit={setEditing}
                onHoldings={setHoldingsFor}
              />
            </CardContent>
          </Card>
        )}

        {production && connections.data && (
          <p className="text-xs text-muted-foreground">
            Plaid Items used: {connections.data.itemsUsed} of {TRIAL_ITEM_LIMIT} (Trial plan). Removed Items still count.
          </p>
        )}
      </div>

      <NewAccountDialog open={creating} onOpenChange={setCreating} />
      <ImportDialog accounts={accounts.data?.accounts ?? []} open={importing} onOpenChange={setImporting} />
      <EditAccountDialog account={editing} onClose={() => setEditing(null)} />
      <HoldingsDialog account={holdingsFor} onClose={() => setHoldingsFor(null)} />
    </>
  );
}

function AccountList({
  accounts,
  currency,
  ownerName,
  onEdit,
  onHoldings,
}: {
  accounts: AccountSummary[];
  currency: 'USD' | 'AUD';
  ownerName: (id: string | null) => string;
  onEdit: (account: AccountSummary) => void;
  onHoldings?: (account: AccountSummary) => void;
}) {
  if (accounts.length === 0) return <p className="text-sm text-muted-foreground">No accounts.</p>;
  return (
    <ul className="divide-y">
      {accounts.map((account) => (
        <li key={account.id} className={`flex items-center justify-between gap-3 py-2 text-sm ${account.isHidden ? 'opacity-60' : ''}`}>
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 truncate font-medium">
              {account.isHidden && <EyeOff className="size-3.5" aria-label="Hidden" />}
              {account.name}
              {account.mask && <span className="font-normal text-muted-foreground">··{account.mask}</span>}
            </p>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {account.subtype ?? account.type}
              <Badge variant={account.ownerUserId ? 'outline' : 'gold'}>{ownerName(account.ownerUserId)}</Badge>
              {account.isHidden && <Badge variant="outline">Hidden — not synced or counted</Badge>}
              {account.missingSince && !account.isHidden && (
                <Badge variant="warning" title="Closed, or deselected when linking. History is kept; hide or disconnect to tidy up.">
                  No longer reported — not counted
                </Badge>
              )}
              {account.holdingCount > 0 && <span>{account.holdingCount} holdings</span>}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <span className="mr-2 font-medium">{account.isHidden ? '—' : money(account.displayBalance, currency)}</span>
            {onHoldings && (account.type === 'investment' || account.holdingCount > 0) && (
              <Button variant="ghost" size="icon" onClick={() => onHoldings(account)} aria-label="Edit holdings" title="Holdings">
                <Layers />
              </Button>
            )}
            <Button variant="ghost" size="icon" onClick={() => onEdit(account)} aria-label="Edit account" title="Edit">
              <Pencil />
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
