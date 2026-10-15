import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchPaddleSubscriptionManageUrl } from "@/lib/paddle-api";

function fakeFetch(impl: (url: string) => Promise<Response>) {
  return vi.fn((input: RequestInfo | URL) => impl(String(input))) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const withManageUrls = {
  data: {
    id: "sub_1",
    management_urls: {
      update_payment_method: "https://sandbox-customer-portal.paddle.com/update",
      cancel: "https://sandbox-customer-portal.paddle.com/cancel",
    },
  },
};

afterEach(() => {
  delete process.env.PADDLE_API_KEY;
  delete process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT;
});

describe("fetchPaddleSubscriptionManageUrl", () => {
  it("is null when PADDLE_API_KEY is unset — no request made", async () => {
    const fetchImpl = fakeFetch(async () => jsonResponse(withManageUrls));
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns update_payment_method, authenticated against the live host by default", async () => {
    process.env.PADDLE_API_KEY = "pdl_live_key";
    const fetchImpl = fakeFetch(async () => jsonResponse(withManageUrls));
    const url = await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl });
    expect(url).toBe("https://sandbox-customer-portal.paddle.com/update");
    const [calledUrl, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(calledUrl).toBe("https://api.paddle.com/subscriptions/sub_1");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer pdl_live_key");
  });

  it("uses the sandbox host when NEXT_PUBLIC_PADDLE_ENVIRONMENT=sandbox", async () => {
    process.env.PADDLE_API_KEY = "pdl_sdbx_key";
    process.env.NEXT_PUBLIC_PADDLE_ENVIRONMENT = "sandbox";
    const fetchImpl = fakeFetch(async () => jsonResponse(withManageUrls));
    await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(
      "https://sandbox-api.paddle.com/subscriptions/sub_1",
    );
  });

  it("falls back to cancel when there is no update_payment_method", async () => {
    process.env.PADDLE_API_KEY = "k";
    const fetchImpl = fakeFetch(async () =>
      jsonResponse({ data: { management_urls: { cancel: "https://portal/cancel" } } }),
    );
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl })).toBe("https://portal/cancel");
  });

  it("is null when the subscription has no management_urls (the real webhook case)", async () => {
    process.env.PADDLE_API_KEY = "k";
    const fetchImpl = fakeFetch(async () => jsonResponse({ data: { id: "sub_1" } }));
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl })).toBeNull();
  });

  it("is null on a non-2xx response", async () => {
    process.env.PADDLE_API_KEY = "k";
    const fetchImpl = fakeFetch(async () => new Response("nope", { status: 404 }));
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl })).toBeNull();
  });

  it("is null on a network error or unexpected shape", async () => {
    process.env.PADDLE_API_KEY = "k";
    const throwing = fakeFetch(async () => {
      throw new Error("network");
    });
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl: throwing })).toBeNull();

    const weird = fakeFetch(async () => jsonResponse({ nope: true }));
    expect(await fetchPaddleSubscriptionManageUrl("sub_1", { fetchImpl: weird })).toBeNull();
  });
});
