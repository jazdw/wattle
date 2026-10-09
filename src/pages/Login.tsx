import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Logo } from '../components/Layout';
import { Button } from '../components/ui/button';
import { Alert } from '../components/ui/misc';
import { useAuth } from '../hooks/useAuth';

const MESSAGES: Record<string, string> = {
  not_allowed: 'That Google account is not allowed to use Wattle.',
  invalid_state: 'Your sign-in session expired. Please try again.',
  token_error: 'Google rejected the sign-in. Please try again.',
  profile_error: 'Could not read your Google profile. Please try again.',
  email_unverified: 'Your Google email is not verified.',
  config_error: 'Google sign-in is not configured on the server.',
  oauth_failed: 'Something went wrong during sign-in.',
};

export function Login() {
  const { me } = useAuth();
  const [params] = useSearchParams();
  const error = params.get('auth');
  const [devError, setDevError] = useState<string | null>(null);
  const devUsers = useQuery({
    queryKey: ['dev-users'],
    queryFn: () => api<{ users: { email: string; name: string }[] }>('/api/auth/dev-users'),
    enabled: import.meta.env.DEV,
    retry: false,
  });

  if (me) return <Navigate to="/" replace />;

  async function signInDev(email: string) {
    const response = await fetch(`/api/auth/dev?email=${encodeURIComponent(email)}`, { credentials: 'same-origin' });
    if (!response.ok) {
      setDevError(`Dev sign-in failed (${response.status})`);
      return;
    }
    window.location.assign('/');
  }

  return (
    <div className="grid min-h-screen place-items-center bg-eucalypt px-4">
      <div className="w-full max-w-sm rounded-xl border bg-card p-8 text-center shadow-lg">
        <Logo className="mx-auto mb-4 size-16 rounded-2xl" />
        <h1 className="text-2xl font-semibold">Wattle</h1>
        <p className="mb-6 mt-1 text-sm text-muted-foreground">Our household's net worth and investments, privately.</p>
        {error && (
          <div className="mb-4">
            <Alert variant="error">{MESSAGES[error] ?? 'Sign-in failed.'}</Alert>
          </div>
        )}
        <Button asChild className="w-full" size="lg">
          <a href="/api/auth/google">Sign in with Google</a>
        </Button>
        {import.meta.env.DEV && (devUsers.data?.users.length ?? 0) > 0 && (
          <div className="mt-6 border-t pt-4">
            <p className="mb-2 text-xs text-muted-foreground">Dev sign-in (local only)</p>
            <div className="flex flex-wrap justify-center gap-2">
              {devUsers.data!.users.map((user) => (
                <Button key={user.email} variant="outline" size="sm" onClick={() => void signInDev(user.email)}>
                  {user.name}
                </Button>
              ))}
            </div>
            {devError && <p className="mt-2 text-xs text-negative">{devError}</p>}
          </div>
        )}
      </div>
    </div>
  );
}
