import { beforeEach, describe, expect, it, vi } from "vitest";

import { getPaddleIpAllowlist, resetPaddleIpAllowlistCache } from "@/lib/paddle-ips";

const TTL_MS = 60 * 60 * 1000;

function okResponse(cidrs: string[]) {
  return new Response(JSON.stringify({ data: { ipv4_cidrs: cidrs }, meta: { request_id: "x" } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fakeFetch(impl: () => Promise<Response>) {
  return vi.fn(impl) as unknown as typeof fetch;
}

beforeEach(() => {
  resetPaddleIpAllowlistCache();
});

describe("getPaddleIpAllowlist", () => {
  it("fetches and returns data.ipv4_cidrs", async () => {
    const fetchImpl = fakeFetch(async () => okResponse(["34.194.127.46/32", "52.29.196.34/32"]));
    expect(await getPaddleIpAllowlist({ fetchImpl })).toEqual([
      "34.194.127.46/32",
      "52.29.196.34/32",
    ]);
  });

  it("serves the cached list within the TTL without refetching", async () => {
    const fetchImpl = fakeFetch(async () => okResponse(["34.194.127.46/32"]));
    await getPaddleIpAllowlist({ fetchImpl, now: 0 });
    await getPaddleIpAllowlist({ fetchImpl, now: TTL_MS - 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches once the TTL has passed", async () => {
    const fetchImpl = fakeFetch(async () => okResponse(["34.194.127.46/32"]));
    await getPaddleIpAllowlist({ fetchImpl, now: 0 });
    await getPaddleIpAllowlist({ fetchImpl, now: TTL_MS + 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent callers into one request", async () => {
    const fetchImpl = fakeFetch(async () => okResponse(["34.194.127.46/32"]));
    const [a, b] = await Promise.all([
      getPaddleIpAllowlist({ fetchImpl }),
      getPaddleIpAllowlist({ fetchImpl }),
    ]);
    expect(a).toEqual(["34.194.127.46/32"]);
    expect(b).toEqual(["34.194.127.46/32"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps serving the stale list when a later refetch fails", async () => {
    await getPaddleIpAllowlist({
      fetchImpl: fakeFetch(async () => okResponse(["34.194.127.46/32"])),
      now: 0,
    });
    const result = await getPaddleIpAllowlist({
      fetchImpl: fakeFetch(async () => {
        throw new Error("network");
      }),
      now: TTL_MS + 1,
    });
    expect(result).toEqual(["34.194.127.46/32"]);
  });

  it("is null when the first fetch fails and nothing is cached", async () => {
    const result = await getPaddleIpAllowlist({
      fetchImpl: fakeFetch(async () => {
        throw new Error("network");
      }),
    });
    expect(result).toBeNull();
  });

  it("is null on a non-2xx response", async () => {
    const result = await getPaddleIpAllowlist({
      fetchImpl: fakeFetch(async () => new Response("nope", { status: 503 })),
    });
    expect(result).toBeNull();
  });

  it("is null when the response shape is not what Paddle documents", async () => {
    const result = await getPaddleIpAllowlist({
      fetchImpl: fakeFetch(async () => new Response(JSON.stringify({ nope: true }), { status: 200 })),
    });
    expect(result).toBeNull();
  });
});
