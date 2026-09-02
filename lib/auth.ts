import { hash as argon2Hash, verify as argon2Verify, type Algorithm } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { z } from "zod";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { getServerEnv } from "@/env";
import { lazyProxy } from "@/lib/lazy";
import { PRIVACY_VERSION, TERMS_VERSION } from "@/lib/legal";
import { resolvePasswordResetDelivery } from "@/lib/password-reset-delivery";
import { resolveVerificationDelivery } from "@/lib/verification-delivery";

/**
 * Built on first use, not on import. `next build` loads this module while
 * collecting page data, and a build machine has no `BETTER_AUTH_SECRET` — see
 * `lib/lazy.ts` for the deploy this comes from.
 */
let instance: ReturnType<typeof createAuth> | undefined;

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

/**
 * The one way the auth limits may be stood down, and why it cannot happen in
 * production.
 *
 * Five sign-ups an hour per instance is the right rule for a studio and an
 * impossible budget for a browser suite: every Playwright scenario registers a
 * real owner and a real master through this very endpoint, which is what makes
 * those tests worth having. So the limits step aside for them — but only when
 * two things are true at once: the switch is set deliberately, and the server
 * is pointed at a database whose name ends in `_test`, the same marker
 * `tests/test-database-env.ts` refuses to run destructive suites without.
 *
 * A production instance fails the second condition no matter what its
 * environment says, so a leaked or copy-pasted `AUTH_RATE_LIMIT=off` does
 * nothing there.
 */
function relaxedForBrowserTests(): boolean {
  if (process.env.AUTH_RATE_LIMIT !== "off") return false;
  try {
    return new URL(process.env.DATABASE_URL ?? "").pathname.endsWith("_test");
  } catch {
    return false;
  }
}

function createAuth() {
  const env = getServerEnv();

  return betterAuth({
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
  user: {
    additionalFields: {
      legalAccepted: {
        type: "boolean",
        required: true,
        returned: false,
        validator: { input: z.literal(true) },
      },
      termsVersion: {
        type: "string",
        required: false,
        input: false,
        returned: false,
        defaultValue: TERMS_VERSION,
      },
      termsAcceptedAt: {
        type: "date",
        required: false,
        input: false,
        returned: false,
        defaultValue: () => new Date(),
      },
      privacyVersion: {
        type: "string",
        required: false,
        input: false,
        returned: false,
        defaultValue: PRIVACY_VERSION,
      },
      privacyAcknowledgedAt: {
        type: "date",
        required: false,
        input: false,
        returned: false,
        defaultValue: () => new Date(),
      },
    },
  },
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    password: {
      hash: (password) => argon2Hash(password, argon2Options),
      verify: ({ hash, password }) => argon2Verify(hash, password, argon2Options),
    },
    // Section 4.3 account recovery. One hour rather than the library default of
    // one hour restated explicitly, so the window is a decision and not an
    // accident. Better Auth answers /forget-password identically whether or not
    // the address exists, and pads the timing, so the endpoint cannot be used to
    // enumerate accounts.
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await resolvePasswordResetDelivery().send({ email: user.email, url });
    },
  },
  /**
   * Confirming the address, and deliberately not gating anything on it.
   *
   * `requireEmailVerification` stays off: the path from registration to a
   * studio's first calculated visit is three steps, and putting a trip to an
   * inbox in the middle of it would cost activations to protect against a typo.
   * So the letter goes out at sign-up, the product opens immediately, and the
   * unconfirmed state is said once in a strip across the top.
   *
   * What the confirmation is actually for is recovery: `sendResetPassword`
   * above is the only way back into an account, and it goes to this address. A
   * studio that mistyped it finds out months later, locked out of its own
   * books. Twenty-four hours to click, because somebody registering on a Friday
   * evening reads their mail on Monday.
   */
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await resolveVerificationDelivery().send({ email: user.email, url });
    },
  },
  /**
   * Spec section 15.3 requires rate limits on auth. Storage is in-memory, which
   * is per-instance: correct for the single-instance pilot, but a multi-instance
   * deployment needs `storage: "database"` and its table before the limits mean
   * anything. Enabled in every environment, not just production.
   */
  rateLimit: {
    enabled: !relaxedForBrowserTests(),
    window: 60,
    max: 100,
    customRules: {
      "/sign-in/email": { window: 300, max: 10 },
      "/sign-up/email": { window: 3600, max: 5 },
      // Paths must match Better Auth's own routes exactly — a rule for a path
      // that does not exist silently limits nothing.
      "/request-password-reset": { window: 3600, max: 5 },
      // Re-sending the confirmation is a button anybody can hold down, and every
      // press costs a real email.
      "/send-verification-email": { window: 3600, max: 5 },
      "/reset-password": { window: 3600, max: 5 },
    },
  },
  });
}

export const auth: ReturnType<typeof createAuth> = lazyProxy(() => (instance ??= createAuth()));
