/**
 * The cron the outbox has been waiting for.
 *
 * Section 7.7 splits writing a message from sending it, and the sending half
 * needs something to start it. On a laptop that is `npm run ops:notifications`;
 * in the deployment it is this. Without it the queue fills and nothing leaves —
 * which is the state this pilot was in, with a fortnight of client messages
 * sitting at `pending` and nobody the wiser.
 *
 * It carries no database credentials and no tenant logic on purpose. It knows
 * one URL and one shared secret; the endpoint behind them walks the tenants
 * inside the application's own RLS boundary. A scheduled function holding the
 * production superuser connection string would be a far larger thing to get
 * wrong than a missed message.
 *
 * Every five minutes. A booking request is answered by a person on their next
 * break, not their next second, and five minutes keeps the invocation count
 * boring while making the worst case for a waiting client a few minutes rather
 * than a few hours. The endpoint is idempotent — messages are claimed with
 * `for update skip locked` — so an overlapping run splits the queue instead of
 * sending twice.
 */
export default async function handler() {
  const token = process.env.OPS_API_TOKEN;
  // `URL` is Netlify's own name for the deployed site; the explicit setting
  // wins so a preview deploy cannot be pointed at production's queue.
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.URL ?? "").replace(/\/+$/, "");

  if (!token || !base) {
    // Not an error to retry: the deployment has not been given what it needs,
    // and saying so once per run is how that becomes visible.
    console.log(
      JSON.stringify({
        level: "warn",
        event: "notifications.cron_not_configured",
        has_token: Boolean(token),
        has_base_url: Boolean(base),
      }),
    );
    return;
  }

  const response = await fetch(`${base}/api/v1/ops/notifications`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    // No organization: drain every tenant that has something due.
    body: JSON.stringify({}),
  });

  const body = (await response.json().catch(() => null)) as {
    data?: { claimed: number; sent: number; retried: number; dead_lettered: number };
    error?: { code: string };
  } | null;

  if (!response.ok) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "notifications.cron_failed",
        status: response.status,
        code: body?.error?.code ?? null,
      }),
    );
    return;
  }

  console.log(
    JSON.stringify({
      level: "info",
      event: "notifications.cron_ran",
      ...(body?.data ?? {}),
    }),
  );
}

export const config = { schedule: "*/5 * * * *" };
