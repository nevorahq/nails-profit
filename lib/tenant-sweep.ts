/**
 * How many studios the cron's sweeps work on at once.
 *
 * One at a time stopped fitting on 6 October 2026: the endpoint runs in
 * Netlify's us-east-1 and the database lives in eu-west-1, so every statement
 * is a transatlantic round trip, and a studio with nothing due still costs a
 * couple of dozen of them across the three sweeps — five short transactions,
 * each with its own `set_config` lines. Every studio in a row came to more than
 * the gateway would wait: each attempt in the cron's log ends in a 504 about
 * thirty seconds in, and the studios at the end of the list were never reached
 * at all.
 *
 * Five, not more: each studio in flight holds one connection of the pool's ten
 * (`db/index.ts`) for one short transaction at a time, which leaves the other
 * half for anything else the same instance is asked to do meanwhile.
 */
export const SWEEP_CONCURRENCY = 5;

/**
 * Runs `work` for every item, at most `concurrency` of them at a time.
 *
 * A failure stops anything new from starting, waits for what is already
 * running, and is then thrown — the same outcome a sequential loop had, minus
 * the work it would have left half-done behind a rejected promise while the
 * response was already on its way out.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failure: { error: unknown } | null = null;

  async function worker() {
    while (failure === null && next < items.length) {
      const item = items[next++];
      try {
        await work(item);
      } catch (error) {
        failure ??= { error };
      }
    }
  }

  const workers = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure !== null) throw (failure as { error: unknown }).error;
}
