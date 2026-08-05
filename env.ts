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
