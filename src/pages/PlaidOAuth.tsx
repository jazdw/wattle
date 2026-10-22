import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PageHeader } from '../components/Layout';
import { Card, CardContent } from '../components/ui/card';
import { Alert } from '../components/ui/misc';
import { readPendingLink, usePlaidLink, type PendingLink } from '../hooks/usePlaidLink';

/**
 * Where a bank's own login (OAuth) sends the browser back on a phone. Reopens
 * Plaid Link with the session started on the Accounts page to finish linking.
 * The address is registered with Plaid as an allowed redirect URI.
 */
export function PlaidOAuth() {
  const [pending] = useState<PendingLink | null>(() => readPendingLink());
  return pending ? <Resume pending={pending} /> : <Expired />;
}

function Resume({ pending }: { pending: PendingLink }) {
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const link = usePlaidLink({
    connectionId: pending.connectionId,
    onError: setError,
    onLinked: () => navigate('/accounts', { replace: true }),
  });
  const started = useRef(false);
  useEffect(() => {
    // Once, even when React runs effects twice in development.
    if (started.current) return;
    started.current = true;
    link.resume(pending);
  }, [link, pending]);

  return (
    <>
      <PageHeader title="Linking your account" />
      <Card>
        <CardContent className="grid gap-3 pt-6">
          {error ? (
            <>
              <Alert variant="error">{error}</Alert>
              <Link className="text-sm underline" to="/accounts" replace>
                Back to Accounts
              </Link>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">{link.importing ? 'Importing your accounts…' : 'Finishing with Plaid…'}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}

function Expired() {
  return (
    <>
      <PageHeader title="Linking your account" />
      <Card>
        <CardContent className="grid gap-3 pt-6">
          <Alert variant="warning">This linking session has ended. Start again from Accounts, in the same browser you use to sign in to your bank.</Alert>
          <Link className="text-sm underline" to="/accounts" replace>
            Back to Accounts
          </Link>
        </CardContent>
      </Card>
    </>
  );
}
