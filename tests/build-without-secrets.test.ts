import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The deploy that failed, as a test.
 *
 * `next build` loads every route's module graph to collect page data, and it
 * does that on a machine that has no production secrets. The root layout reads
 * the organization's language, which reached the auth instance and the database
 * handle, and both of them validated `DATABASE_URL`, `BETTER_AUTH_SECRET` and
 * `BETTER_AUTH_URL` while being constructed. The build died on `/_not-found` —
 * a page with no data in it at all.
 *
 * Nothing in the local build could see this: a developer has a `.env`, so the
 * secrets are there and the modules construct happily. The property that has to
 * hold is not "the build passes" but "the build passes without secrets", and
 * only a test that takes them away can tell the difference.
 *
 * Both halves matter. Importing must not construct anything, and the render
 * must consult the request before it consults a secret — otherwise Next never
 * gets to find out the page is dynamic, because the error arrives first.
 */
const SECRETS = ["DATABASE_URL", "BETTER_AUTH_SECRET", "BETTER_AUTH_URL"] as const;

describe("a build machine with no secrets", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const name of SECRETS) {
      saved[name] = process.env[name];
      delete process.env[name];
    }
    vi.resetModules();
  });

  afterEach(() => {
    for (const name of SECRETS) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("can import the database handle", async () => {
    const loaded = await import("@/db");
    expect(loaded.db).toBeDefined();
    expect(loaded.sqlClient).toBeDefined();
  });

  it("can import the auth instance", async () => {
    const loaded = await import("@/lib/auth");
    expect(loaded.auth).toBeDefined();
  });

  it("can import the module the root layout renders through", async () => {
    const loaded = await import("@/lib/locale");
    expect(loaded.resolveLocale).toBeInstanceOf(Function);
  });

  it("can import Better Auth's own route", async () => {
    // `toNextJsHandler` wraps the handler in a closure rather than reading
    // `auth.handler` at module scope, so this passes on the library's own
    // idiom. It is here because that is a property of a dependency, and a
    // version that stopped wrapping would take the build down with it.
    const loaded = await import("@/app/api/auth/[...all]/route");
    expect(loaded.GET).toBeInstanceOf(Function);
    expect(loaded.POST).toBeInstanceOf(Function);
  });

  it("asks for the request before it asks for a secret", async () => {
    // Next signals "this render cannot be prerendered" by throwing out of
    // `headers()`. That signal has to come first: reaching for the auth
    // instance before it turns a dynamic page into a failed build.
    const bailout = new Error("dynamic server usage");
    vi.doMock("next/headers", () => ({
      headers: () => {
        throw bailout;
      },
    }));

    const { resolveLocale } = await import("@/lib/locale");
    await expect(resolveLocale()).rejects.toBe(bailout);
  });
});
