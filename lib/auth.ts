import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { getServerEnv } from "@/env";

const env = getServerEnv();

/**
 * Spec section 15.3 requires Argon2id or bcrypt. Better Auth defaults to scrypt,
 * which is not on that list, so the hasher is replaced here. Switching later
 * would strand every existing hash; doing it before the first real account
 * costs nothing.
 *
 * Parameters follow the OWASP Password Storage Cheat Sheet minimum for
 * Argon2id: 19 MiB of memory, two iterations, one degree of parallelism.
 */
// `Algorithm` is an ambient const enum, which `isolatedModules` cannot inline,
// so the member value is written out: Argon2d = 0, Argon2i = 1, Argon2id = 2.
const ARGON2ID = 2 as Algorithm;

const argon2Options = {
  algorithm: ARGON2ID,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export const auth = betterAuth({
  appName: "Nail Profit OS",
  baseURL: env.BETTER_AUTH_URL,
  secret: env.BETTER_AUTH_SECRET,
  // Section 15.3 CSRF protection: only these origins may drive cookie-authenticated
  // mutations. Left implicit, Better Auth would trust baseURL alone.
  trustedOrigins: [env.BETTER_AUTH_URL],
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
    usePlural: true,
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    password: {
      hash: (password) => argon2Hash(password, argon2Options),
      verify: ({ hash, password }) => argon2Verify(hash, password, argon2Options),
    },
  },
  /**
   * Spec section 15.3 requires rate limits on auth. Storage is in-memory, which
   * is per-instance: correct for the single-instance pilot, but a multi-instance
   * deployment needs `storage: "database"` and its table before the limits mean
   * anything. Enabled in every environment, not just production.
   */
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 300, max: 10 },
      "/sign-up/email": { window: 3600, max: 5 },
      "/forget-password": { window: 3600, max: 5 },
      "/reset-password": { window: 3600, max: 5 },
    },
  },
});
