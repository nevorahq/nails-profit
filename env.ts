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
 * `PADDLE_WEBHOOK_SECRET` above. Placeholder/unset on purpose until Paddle
 * confirms a seller account is possible without an EU/US entity (open
 * question from the payments research); `null` hides the button rather than
 * rendering one that opens a checkout for nothing real.
 */
export function getPaddleCheckoutConfig() {
  const clientToken = process.env.NEXT_PUBLIC_PADDLE_CLIENT_TOKEN?.trim();
  const priceId = process.env.NEXT_PUBLIC_PADDLE_PRICE_ID?.trim();
  return clientToken && priceId ? { clientToken, priceId } : null;
}

/** Same reasoning as `getPaddleCheckoutConfig`, for Lemon Squeezy's plain hosted-checkout link. */
export function getLemonSqueezyCheckoutUrl() {
  const value = process.env.NEXT_PUBLIC_LEMON_SQUEEZY_CHECKOUT_URL?.trim();
  return value || null;
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
