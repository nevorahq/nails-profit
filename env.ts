import { z } from "zod";

const serverEnvSchema = z.object({
  DATABASE_URL: z.url().startsWith("postgres"),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.url(),
});

export function getServerEnv() {
  return serverEnvSchema.parse({
    DATABASE_URL: process.env.DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  });
}

export function isPilotAccessEnforced() {
  const value = process.env.PILOT_ACCESS_ENFORCEMENT;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("PILOT_ACCESS_ENFORCEMENT must be true or false");
}

export function isPublicBookingEnabled() {
  const value = process.env.PUBLIC_BOOKING_ENABLED;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("PUBLIC_BOOKING_ENABLED must be true or false");
}

/**
 * The rollback plan of section 7 pauses delivery without deleting history:
 * with this off the outbox keeps filling and nothing leaves the queue, so
 * turning it back on sends what was written meanwhile instead of losing it.
 */
export function areNotificationsEnabled() {
  const value = process.env.NOTIFICATIONS_ENABLED;
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("NOTIFICATIONS_ENABLED must be true or false");
}

/**
 * Which adapter sends a message. `log` is local-only; the production pilot
 * uses Resend after its sending domain and credentials pass the runbook.
 */
export function getNotificationProviderName() {
  const value = (process.env.NOTIFICATION_PROVIDER ?? "log").trim();
  if (value === "log" || value === "resend") return value;
  throw new Error("NOTIFICATION_PROVIDER must be log or resend");
}

/** Contact the public booking flow must verify for the configured provider. */
export function getPublicNotificationChannel(): "email" | "sms" {
  return getNotificationProviderName() === "resend" ? "email" : "sms";
}

const resendEnvSchema = z.object({
  apiKey: z.string().trim().min(10),
  from: z
    .string()
    .trim()
    .min(3)
    .max(320)
    .refine((value) => !/[\r\n]/.test(value), "RESEND_FROM must be one line"),
});

/**
 * Server-only credentials for the chosen Phase 7 email provider.
 *
 * Two names for the sender, because the deployment already had the other one:
 * production carried `RESEND_FROM_EMAIL` while this read `RESEND_FROM`, so with
 * the provider set to `resend` every send threw on a missing variable and the
 * pilot's invitations produced a 500 instead of an email. Accepting both is
 * what keeps that from being a redeploy away from happening again in either
 * direction.
 */
export function getResendConfig() {
  return resendEnvSchema.parse({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM ?? process.env.RESEND_FROM_EMAIL,
  });
}

/**
 * Which SMS adapter sends a message, independent of `NOTIFICATION_PROVIDER`
 * (email): a studio that has Resend configured for email but has not yet
 * finished onboarding with an SMS provider must not have its email silently
 * fall back to `log` because one shared switch tried to cover both channels.
 */
export function getSmsProviderName() {
  const value = (process.env.SMS_PROVIDER ?? "log").trim();
  if (value === "log" || value === "smsmd") return value;
  throw new Error("SMS_PROVIDER must be log or smsmd");
}

const smsMdEnvSchema = z.object({
  // The whole of this API's authentication: the value of `X-Api-Token`, issued
  // in Settings → API with a set of scopes. Sending needs `messages:send`;
  // reading delivery statuses back needs `messages:read` as well.
  token: z.string().trim().min(1),
  /**
   * The registered sender name. Capped at what the API itself accepts rather
   * than at the 11 characters the operators' own registration is described
   * with: an alias that the dashboard approved is valid by definition, and a
   * stricter check here would reject it before the request is ever made.
   */
  from: z.string().trim().min(1).max(15),
});

/**
 * Server-only credentials for the sms.md adapter (`api.sms.md/v3`).
 *
 * `SMSMD_SENDER_ID` is the sender name approved for the account; unlike the
 * token it is not a secret, but a send without it fails with 422, so it is
 * required here rather than defaulted to something that would look like a
 * working configuration.
 */
export function getSmsMdConfig() {
  return smsMdEnvSchema.parse({
    token: process.env.SMSMD_API_TOKEN,
    from: process.env.SMSMD_SENDER_ID ?? process.env.SMSMD_FROM,
  });
}

/** Unset disables the public Resend webhook route (fail closed). */
export function getResendWebhookSecret() {
  const value = process.env.RESEND_WEBHOOK_SECRET?.trim();
  if (!value) return null;
  if (!value.startsWith("whsec_") || value.length < 16) {
    throw new Error("RESEND_WEBHOOK_SECRET must be a Resend whsec_ signing secret");
  }
  return value;
}

/** Unset disables the public Paddle webhook route (fail closed). */
export function getPaddleWebhookSecret() {
  const value = process.env.PADDLE_WEBHOOK_SECRET?.trim();
  if (!value) return null;
  if (value.length < 16) throw new Error("PADDLE_WEBHOOK_SECRET must be at least 16 characters");
  return value;
}

/** Unset disables the public Lemon Squeezy webhook route (fail closed). */
export function getLemonSqueezyWebhookSecret() {
  const value = process.env.LEMON_SQUEEZY_WEBHOOK_SECRET?.trim();
  if (!value) return null;
  if (value.length < 16) throw new Error("LEMON_SQUEEZY_WEBHOOK_SECRET must be at least 16 characters");
  return value;
}

/**
 * The "start subscription" button's own configuration — public by nature,
 * same as a Stripe publishable key: Paddle's own docs call this a
 * client-side token, safe to ship in the browser bundle, unlike
 * `PADDLE_WEBHOOK_SECRET` above. `null` (either value unset) hides the button
 * rather than rendering one that opens a checkout for nothing real.
 *
 * `environment` is `sandbox` only when `NEXT_PUBLIC_PADDLE_ENVIRONMENT` is
 * exactly `sandbox`; anything else (including unset) is `live`, which is
 * Paddle.js's own default. The frontend calls `Paddle.Environment.set('sandbox')`
 * only for the sandbox case — so switching to live is a one-line env change,
 * not a code edit.
 */
export function getPaddleCheckoutConfig() {
  const clientToken = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim();
  const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID?.trim();
  if (!clientToken || !priceId) return null;
  const environment: "sandbox" | "live" =
    process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT?.trim() === "sandbox" ? "sandbox" : "live";
  return { clientToken, priceId, environment };
}

/** Same reasoning as `getPaddleCheckoutConfig`, for Lemon Squeezy's plain hosted-checkout link. */
export function getLemonSqueezyCheckoutUrl() {
  const value = process.env.NEXT_PUBLIC_LEMON_SQUEEZY_CHECKOUT_URL?.trim();
  return value || null;
}

/**
 * Server-side Paddle API access — a secret key (`pdl_sdbx_…` / `pdl_live_…`),
 * unlike the public `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN`. Used today only to read a
 * subscription's `management_urls`, which its webhooks omit; later for
 * upgrades and cancellations. The base URL follows the same
 * `NEXT_PUBLIC_PADDLE_ENVIRONMENT` switch as the frontend. `null` (key unset)
 * makes every server-side Paddle call a no-op — see `lib/paddle-api.ts`.
 */
export function getPaddleApiConfig() {
  const apiKey = process.env.PADDLE_API_KEY?.trim();
  if (!apiKey) return null;
  const baseUrl =
    process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT?.trim() === "sandbox"
      ? "https://sandbox-api.paddle.com"
      : "https://api.paddle.com";
  return { apiKey, baseUrl };
}

/**
 * PostHog's project key is meant to ship in the browser bundle — same class of
 * value as `NEXT_PUBLIC_PADDLE_CLIENT_TOKEN` above, not a secret.
 *
 * `host` is the reverse proxy (e.g. `e.nevorahq.com`, CNAME'd to PostHog's
 * managed proxy), not PostHog's own domain directly — that's what keeps
 * PostHog's own subdomain off the wire for ad blockers to match against.
 * Proxying means the SDK can no longer infer where the PostHog *app* lives
 * (toolbar links, session-replay links) from `host` alone, so `ui_host` says
 * that explicitly. All three are required together: a proxy host without the
 * real app host breaks those links instead of just leaving them unconfigured.
 */
export function getPostHogConfig() {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY?.trim();
  const host = process.env.NEXT_PUBLIC_POSTHOG_HOST?.trim();
  const uiHost = process.env.NEXT_PUBLIC_POSTHOG_UI_HOST?.trim();
  return key && host && uiHost ? { key, host, uiHost } : null;
}

/**
 * Independent of `PILOT_ACCESS_ENFORCEMENT`: a pilot studio's access is
 * decided by its own `pilot_enrollment` row, and turning subscription
 * billing on for everyone else must not silently start requiring it from
 * pilots too.
 */
export function isSubscriptionAccessEnforced() {
  const value = process.env.SUBSCRIPTION_ACCESS_ENFORCEMENT;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("SUBSCRIPTION_ACCESS_ENFORCEMENT must be true or false");
}

/**
 * Whether `POST /api/v1/webhooks/paddle` rejects callers that are not in
 * Paddle's published IP allowlist (https://api.paddle.com/ips). Off by default:
 * the signature check is the hard gate, and this second one only makes sense
 * where the route is reachable solely from the internet — a laptop testing
 * against a tunnel is not on Paddle's addresses. A deployment turns it on.
 * See `lib/paddle-ips.ts`.
 */
export function isPaddleWebhookIpAllowlistEnabled() {
  const value = process.env.PADDLE_WEBHOOK_IP_ALLOWLIST;
  if (value === undefined || value === "false") return false;
  if (value === "true") return true;
  throw new Error("PADDLE_WEBHOOK_IP_ALLOWLIST must be true or false");
}

/**
 * Where a newly registered studio is announced, so that a sign-up is a lead
 * somebody answers rather than a row nobody sees.
 *
 * Unset means nobody is told, the same fail-closed shape as the webhook
 * secrets above: an unconfigured channel that is visibly off beats one that
 * mails a placeholder address for months. Nothing about access depends on it —
 * see `lib/studio-lead-notice.ts` for why the notice never gates the studio it
 * announces.
 *
 * One plain mailbox, not a header: a display name here would be pasted
 * straight into `to`, and a comma or a newline in it turns one recipient into
 * several.
 */
export function getSupportEmail() {
  const value = process.env.SUPPORT_EMAIL?.trim();
  if (!value) return null;
  if (!/^[^\s@,;<>"]+@[^\s@,;<>"]+\.[^\s@,;<>"]+$/.test(value)) {
    throw new Error("SUPPORT_EMAIL must be a single plain address, without a display name");
  }
  return value;
}

/**
 * The application's identity at the browsers' push services (VAPID), or null —
 * in which case push is off and everything else works exactly as before:
 * nothing is queued for a phone, and the switch says the channel is not set up.
 *
 * Both keys together or neither; one without the other is a configuration
 * mistake, not a choice, and is said so at startup rather than at the first
 * request. The public key is not a secret — every browser that subscribes is
 * handed it — but it is read here, at runtime, rather than baked into the
 * bundle as `NEXT_PUBLIC_…`, so rotating the pair needs no rebuild.
 *
 * `VAPID_SUBJECT` is who the push service may write to about abuse:
 * `mailto:` the support address when it is not set, then the site itself.
 */
export function getVapidConfig() {
  const publicKey = process.env.VAPID_PUBLIC_KEY?.trim();
  const privateKey = process.env.VAPID_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set together");
  }
  if (!/^[A-Za-z0-9_-]{80,100}$/.test(publicKey) || !/^[A-Za-z0-9_-]{40,50}$/.test(privateKey)) {
    throw new Error("VAPID keys must be the URL-safe base64 pair from `web-push generate-vapid-keys`");
  }

  const support = getSupportEmail();
  const site = getPublicAppUrl();
  const subject =
    process.env.VAPID_SUBJECT?.trim() ||
    (support ? `mailto:${support}` : site.startsWith("https://") ? site : "");
  if (!/^(mailto:|https:\/\/)/.test(subject)) {
    throw new Error("VAPID_SUBJECT must be a mailto: or https: URL (or set SUPPORT_EMAIL)");
  }

  return { publicKey, privateKey, subject };
}

export function isPushConfigured() {
  return getVapidConfig() !== null;
}

/**
 * Where photos of work are kept, or null — in which case they are off and
 * everything else works as before: the visit card offers no upload and the
 * routes answer that the feature is not set up.
 *
 * - `supabase`: a private Storage bucket, reached over its REST API with the
 *   service-role key. URL and key together or neither; one without the other is
 *   a configuration mistake and is said so at startup.
 * - `filesystem`: a directory on the machine, for local development and the
 *   browser suite only. Chosen explicitly with `PHOTO_STORAGE=filesystem`,
 *   never by default, so a deployment cannot fall back to its own disk.
 */
export type PhotoStorageConfig =
  | Readonly<{ kind: "supabase"; url: string; serviceRoleKey: string; bucket: string }>
  | Readonly<{ kind: "filesystem"; directory: string }>;

export function getPhotoStorageConfig(): PhotoStorageConfig | null {
  // Named outright, the local directory wins over a bucket the same `.env`
  // also describes: a test or local server on the `_test` database must never
  // write its photos into the production bucket.
  if (process.env.PHOTO_STORAGE?.trim() === "filesystem") {
    return { kind: "filesystem", directory: process.env.PHOTO_STORAGE_DIR?.trim() || ".photo-storage" };
  }
  const url = process.env.SUPABASE_URL?.trim();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url || key) {
    if (!url || !key) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set together");
    if (!/^https:\/\/[^/]+$/.test(url.replace(/\/$/, ""))) {
      throw new Error("SUPABASE_URL must be the project's https origin, e.g. https://abc.supabase.co");
    }
    const bucket = process.env.WORK_PHOTOS_BUCKET?.trim() || "work-photos";
    if (!/^[a-z0-9][a-z0-9._-]{1,62}$/.test(bucket)) throw new Error("WORK_PHOTOS_BUCKET is not a valid bucket name");
    return { kind: "supabase", url: url.replace(/\/$/, ""), serviceRoleKey: key, bucket };
  }
  return null;
}

/** The token the notification dispatch job authenticates with; unset disables the route. */
export function getOpsApiToken() {
  const value = process.env.OPS_API_TOKEN?.trim();
  if (!value) return null;
  if (value.length < 32) throw new Error("OPS_API_TOKEN must be at least 32 characters");
  return value;
}

/** Where a client's manage link points. Messages need an absolute URL. */
export function getPublicAppUrl() {
  const value = process.env.NEXT_PUBLIC_APP_URL ?? process.env.BETTER_AUTH_URL ?? "";
  return value.replace(/\/+$/, "");
}

/**
 * Whether a link built on `getPublicAppUrl()` can be opened by the person who
 * receives it.
 *
 * A development server pointed at the production database is a working setup —
 * it is how the pilot is looked after — but it also sends real mail to real
 * people with `http://localhost:3000/join?token=…` inside, which is an
 * invitation only the sender can open. The address is checked before a message
 * goes out rather than trusted, so that mistake stops at a refusal instead of
 * arriving in somebody's inbox looking legitimate.
 */
export function isPublicAppUrlReachable() {
  const value = getPublicAppUrl();
  if (!value) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return !(
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "[::1]" ||
    host.startsWith("127.") ||
    host.endsWith(".local") ||
    host.endsWith(".localhost")
  );
}
