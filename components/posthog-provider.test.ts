import { beforeEach, describe, expect, it, vi } from "vitest";

const posthog = vi.hoisted(() => ({
  init: vi.fn(),
  optIn: vi.fn(),
  optOut: vi.fn(),
}));

vi.mock("react", () => ({
  useEffect: (effect: () => void | (() => void)) => void effect(),
}));

vi.mock("posthog-js", () => ({
  default: {
    init: posthog.init,
    opt_in_capturing: posthog.optIn,
    opt_out_capturing: posthog.optOut,
  },
}));

vi.mock("@/lib/cookie-consent", () => ({
  loadConsent: () => null,
  subscribeToConsent: () => vi.fn(),
}));

describe("PostHogProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("enables Web Vitals capture in the browser SDK", async () => {
    const { PostHogProvider } = await import("./posthog-provider");

    PostHogProvider({
      config: {
        key: "phc_test",
        host: "https://events.example.com",
        uiHost: "https://eu.posthog.com",
      },
    });

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        capture_performance: { web_vitals: true },
      }),
    );
  });
});
