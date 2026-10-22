import { useQuery } from '@tanstack/react-query';
import type { ConnectionSummary, SyncRunSummary } from '../../shared/types';
import { api } from '../api';
import { RunEntry } from './RunEntry';
import { Dialog, DialogContent } from './ui/dialog';
import { Alert, EmptyState, Skeleton } from './ui/misc';

/** The sync log for one connection: every sync and history load, newest first. */
export function ActivityDialog({ connection, onClose }: { connection: ConnectionSummary | null; onClose: () => void }) {
  const activity = useQuery({
    queryKey: ['activity', connection?.id],
    queryFn: () => api<{ runs: SyncRunSummary[] }>(`/api/connections/${connection!.id}/activity`),
    enabled: connection !== null,
  });

  return (
    <Dialog open={connection !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-w-2xl"
        title={`Activity: ${connection?.institutionName ?? 'Institution'}`}
        description="Every sync and history load for this connection over the last two years, newest 50 shown."
      >
        {activity.isPending ? (
          <Skeleton className="h-32 w-full" />
        ) : activity.isError ? (
          <Alert variant="error">{activity.error.message}</Alert>
        ) : activity.data.runs.length === 0 ? (
          <EmptyState title="Nothing logged yet">Syncs are logged from now on.</EmptyState>
        ) : (
          <ul className="grid gap-2">
            {activity.data.runs.map((run) => (
              <RunEntry key={run.id} run={run} />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
