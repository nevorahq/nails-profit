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
  const value = process.env.NOTIFICATION_PROVIDER ?? "log";
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

/** Server-only credentials for the chosen Phase 7 email provider. */
export function getResendConfig() {
  return resendEnvSchema.parse({
    apiKey: process.env.RESEND_API_KEY,
    from: process.env.RESEND_FROM,
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
