import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { clearNewAccountsQuestion, useNewAccountsQuestion } from '../lib/newAccountsQuestion';
import { Button } from './ui/button';
import { Dialog, DialogContent } from './ui/dialog';
import { Alert } from './ui/misc';

/**
 * Asked after Choose accounts adds bank accounts: their history needs a new
 * bank report for the whole login, which Plaid bills per report. Not now
 * still loads any added investment accounts' history (no report needed).
 */
export function NewAccountsHistoryDialog() {
  const question = useNewAccountsQuestion();
  const queryClient = useQueryClient();
  const answer = useMutation({
    mutationFn: async (bankReport: boolean) => {
      if (!question) return;
      const accountIds = question.accounts.filter((account) => bankReport || !account.bank).map((account) => account.id);
      if (accountIds.length === 0) return;
      await api(`/api/connections/${question.connectionId}/new-accounts-history`, { method: 'POST', body: JSON.stringify({ accountIds, bankReport }) });
    },
    onSuccess: () => {
      clearNewAccountsQuestion();
      void queryClient.invalidateQueries();
    },
  });
  if (!question) return null;
  const bank = question.accounts.filter((account) => account.bank);
  const others = question.accounts.filter((account) => !account.bank);

  return (
    <Dialog open onOpenChange={(open) => !open && !answer.isPending && answer.mutate(false)}>
      <DialogContent title="Load history for the new accounts?" description={bank.map((account) => account.name).join(', ')}>
        <div className="grid gap-2 text-sm">
          <p>
            Their balance history comes from a new bank report from Plaid. It covers every account at this login (up to two years), and Plaid bills each report on paid plans.
          </p>
          {others.length > 0 && <p className="text-muted-foreground">{others.map((account) => account.name).join(', ')}: investment history loads either way.</p>}
          <p className="text-muted-foreground">Not now keeps their daily balances from today on. Reload history on the login loads everything later.</p>
        </div>
        {answer.error && <Alert variant="error">{answer.error.message}</Alert>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => answer.mutate(false)} disabled={answer.isPending}>
            Not now
          </Button>
          <Button onClick={() => answer.mutate(true)} disabled={answer.isPending}>
            Load history
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
