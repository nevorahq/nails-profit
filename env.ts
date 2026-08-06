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
 * Which adapter sends a message. `log` writes a redacted line and reports
 * success, which is what a pilot runs on until Entry Gate 7's "выбран
 * transactional messaging provider" is answered with a real vendor.
 */
export function getNotificationProviderName() {
  const value = process.env.NOTIFICATION_PROVIDER ?? "log";
  if (value === "log") return value;
  throw new Error("NOTIFICATION_PROVIDER must be log");
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
