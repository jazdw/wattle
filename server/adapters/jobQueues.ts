/**
 * Ways to wake a runner for jobs (see services/jobRunner.ts). The jobs table
 * is the record; these only deliver "run job X".
 *  - cloudflareJobQueue: a Cloudflare Queue (one message per job; the Worker's
 *    queue() handler runs it, each in its own invocation).
 *  - localJobQueue: the process runs due jobs itself, one at a time (Node).
 * Typed structurally, so nothing here imports Cloudflare's types.
 */
import { describeError } from '../lib/errors';
import type { JobQueue } from '../ports';

export interface JobMessage {
  id: string;
}

/** The parts of a Cloudflare Queue producer binding used here. */
export interface QueueProducer {
  sendBatch(messages: { body: JobMessage; delaySeconds?: number }[]): Promise<unknown>;
}

/** The parts of a Cloudflare Queue consumer batch used here. */
export interface QueueBatch {
  messages: readonly { body: JobMessage; ack(): void; retry(options?: { delaySeconds?: number }): void }[];
}

/** Cloudflare Queues delay messages by at most 24 hours. */
const MAX_DELAY_SECONDS = 24 * 3600;
/** Messages per sendBatch call (Cloudflare's limit). */
const BATCH_SIZE = 100;

const clampDelay = (seconds: number | undefined) =>
  seconds && seconds > 0 ? Math.min(MAX_DELAY_SECONDS, Math.ceil(seconds)) : undefined;

export function cloudflareJobQueue(queue: QueueProducer): JobQueue {
  return {
    async wake(ids, delaySeconds) {
      const delay = clampDelay(delaySeconds);
      for (let index = 0; index < ids.length; index += BATCH_SIZE) {
        await queue.sendBatch(ids.slice(index, index + BATCH_SIZE).map((id) => ({ body: { id }, ...(delay ? { delaySeconds: delay } : {}) })));
      }
    },
  };
}

/**
 * The Worker's queue() handler: run each message's job. A job that can't run
 * yet (another attempt holds it, or it isn't due) is retried after that wait;
 * one whose run failed unexpectedly (the database unreachable) after a minute.
 */
export async function consumeJobs(batch: QueueBatch, run: (id: string) => Promise<{ retryInSeconds?: number }>): Promise<void> {
  for (const message of batch.messages) {
    try {
      const outcome = await run(message.body.id);
      if (outcome.retryInSeconds) message.retry({ delaySeconds: clampDelay(outcome.retryInSeconds) });
      else message.ack();
    } catch (error) {
      console.error('Job runner failed', describeError(error));
      message.retry({ delaySeconds: 60 });
    }
  }
}

/**
 * Run jobs in this process (Node): a wake-up schedules a drain, which runs
 * every due job one at a time until none is left. `due` lists runnable job
 * ids; `run` runs one.
 */
export function localJobQueue(due: () => Promise<string[]>, run: (id: string) => Promise<unknown>): JobQueue & { drain(): Promise<void> } {
  let draining: Promise<void> | null = null;
  let again = false;
  const drainOnce = async () => {
    do {
      again = false;
      for (const id of await due()) await run(id);
    } while (again || (await due()).length > 0);
  };
  const drain = (): Promise<void> => {
    if (draining) {
      again = true;
      return draining;
    }
    draining = drainOnce()
      .catch((error) => console.error('Job runner failed', describeError(error)))
      .finally(() => {
        draining = null;
      });
    return draining;
  };
  return {
    drain,
    async wake(_ids, delaySeconds) {
      const delay = clampDelay(delaySeconds);
      if (delay) setTimeout(() => void drain(), delay * 1000);
      else queueMicrotask(() => void drain());
    },
  };
}
