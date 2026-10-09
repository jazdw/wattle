import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CURRENCIES, type Currency } from '../../shared/money';
import { api } from '../api';
import { PageHeader } from '../components/Layout';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Field, Input, NativeSelect } from '../components/ui/input';
import { Alert } from '../components/ui/misc';
import { useConnections } from '../hooks/queries';
import { useAuth } from '../hooks/useAuth';

export function Settings() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const connections = useConnections();
  const [name, setName] = useState(me?.household.name ?? '');
  const [displayCurrency, setDisplayCurrency] = useState<Currency>(me?.household.displayCurrency ?? 'USD');

  const save = useMutation({
    mutationFn: () => api('/api/household', { method: 'PATCH', body: JSON.stringify({ name, displayCurrency }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['me'] }),
  });

  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Household</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Name">
              <Input value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            <Field label="Default display currency" hint="Each browser can switch with the USD/AUD toggle.">
              <NativeSelect value={displayCurrency} onChange={(event) => setDisplayCurrency(event.target.value as Currency)}>
                {CURRENCIES.map((currency) => (
                  <option key={currency}>{currency}</option>
                ))}
              </NativeSelect>
            </Field>
            {save.error && <Alert variant="error">{save.error.message}</Alert>}
            <Button className="justify-self-start" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isSuccess ? 'Saved' : 'Save'}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Members</CardTitle>
            <CardDescription>Sign-in is limited to the allow-list (managed with <code>npm run allow</code>).</CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="divide-y text-sm">
              {me?.household.members.map((member) => (
                <li key={member.id} className="flex items-center gap-3 py-2">
                  {member.picture ? (
                    <img src={member.picture} alt="" className="size-8 rounded-full" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="grid size-8 place-items-center rounded-full bg-muted">{member.name[0]}</span>
                  )}
                  <div>
                    <p className="font-medium">{member.name}</p>
                    <p className="text-xs text-muted-foreground">{member.email}</p>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Data & privacy</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-2 text-sm text-muted-foreground">
            <p>Only account masks (last 4 digits) are stored, never full account or routing numbers.</p>
            <p>Bank access tokens are encrypted at rest. Hidden accounts are not synced or stored.</p>
            <p>Plaid environment: {connections.data?.plaidEnv ?? 'not configured'}.</p>
            <p>Prices: Tiingo (daily closes, incl. mutual funds), Finnhub (live stock/ETF quotes), ECB rates for USD↔AUD.</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
