import webpush from "web-push";
import { afterEach, describe, expect, it } from "vitest";

import { getVapidConfig, isPushConfigured } from "@/env";

/**
 * Push is optional: without keys it is off and nothing else changes, and half a
 * pair is a mistake that should stop the server rather than fail on the first
 * send to somebody's phone.
 */
const keys = webpush.generateVAPIDKeys();
const saved = { ...process.env };

afterEach(() => {
  for (const name of ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "SUPPORT_EMAIL", "NEXT_PUBLIC_APP_URL"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

function set(values: Record<string, string | undefined>) {
  for (const [name, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("VAPID configuration", () => {
  it("is off without keys", () => {
    set({ VAPID_PUBLIC_KEY: undefined, VAPID_PRIVATE_KEY: undefined });
    expect(getVapidConfig()).toBeNull();
    expect(isPushConfigured()).toBe(false);
  });

  it("refuses half a pair", () => {
    set({ VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: undefined });
    expect(() => getVapidConfig()).toThrow(/together/);
  });

  it("refuses keys that are not a web-push pair", () => {
    set({ VAPID_PUBLIC_KEY: "short", VAPID_PRIVATE_KEY: keys.privateKey });
    expect(() => getVapidConfig()).toThrow(/URL-safe base64/);
  });

  it("names the support address as the subject when none is set", () => {
    set({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: undefined,
      SUPPORT_EMAIL: "help@studio.example",
    });
    expect(getVapidConfig()).toEqual({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: "mailto:help@studio.example",
    });
  });

  it("falls back to the site itself, and refuses a subject a push service cannot use", () => {
    set({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: undefined,
      SUPPORT_EMAIL: undefined,
      NEXT_PUBLIC_APP_URL: "https://app.studio.example",
    });
    expect(getVapidConfig()?.subject).toBe("https://app.studio.example");

    set({ NEXT_PUBLIC_APP_URL: "http://localhost:3000" });
    expect(() => getVapidConfig()).toThrow(/VAPID_SUBJECT/);
  });
});
