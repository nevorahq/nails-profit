import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { getPhotoStorageConfig } from "@/env";
import {
  filesystemPhotoStorage,
  photoStoragePath,
  PhotoStorageError,
  supabasePhotoStorage,
} from "@/lib/photo-storage";

const ORG = "11111111-1111-4111-8111-111111111111";
const VISIT = "22222222-2222-4222-8222-222222222222";
const PHOTO = "33333333-3333-4333-8333-333333333333";
const CONFIG = {
  kind: "supabase" as const,
  url: "https://project.supabase.co",
  serviceRoleKey: "service-role-secret",
  bucket: "work-photos",
};

type Call = { url: string; init: RequestInit };

function fakeFetch(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("photoStoragePath", () => {
  it("is organization / visit / photo, one prefix per studio", () => {
    expect(photoStoragePath(ORG, VISIT, PHOTO, "image/webp")).toBe(`${ORG}/${VISIT}/${PHOTO}.webp`);
  });

  it("is built from ids only", () => {
    expect(() => photoStoragePath("../other", VISIT, PHOTO, "image/webp")).toThrow();
    expect(() => photoStoragePath(ORG, VISIT, PHOTO, "image/gif")).toThrow();
  });
});

describe("the Supabase driver", () => {
  it("uploads into the private bucket with the service key and never overwrites", async () => {
    const { impl, calls } = fakeFetch(() => new Response("{}", { status: 200 }));
    await supabasePhotoStorage(CONFIG, impl).put(`${ORG}/${VISIT}/${PHOTO}.webp`, new Uint8Array([1]), "image/webp");

    expect(calls[0].url).toBe(`https://project.supabase.co/storage/v1/object/work-photos/${ORG}/${VISIT}/${PHOTO}.webp`);
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toMatchObject({
      authorization: "Bearer service-role-secret",
      "content-type": "image/webp",
      "x-upsert": "false",
    });
  });

  it("signs a link that expires, absolute to the project", async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ signedURL: "/object/sign/work-photos/a.webp?token=t" }), { status: 200 }),
    );
    const url = await supabasePhotoStorage(CONFIG, impl).signedUrl("a.webp", 3600);

    expect(url).toBe("https://project.supabase.co/storage/v1/object/sign/work-photos/a.webp?token=t");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ expiresIn: 3600 });
  });

  it("signs a whole archive in one call", async () => {
    const { impl, calls } = fakeFetch(
      () =>
        new Response(
          JSON.stringify([
            { path: "a.webp", signedURL: "/object/sign/work-photos/a.webp?token=1" },
            { path: "gone.webp", signedURL: null, error: "Either the object does not exist" },
          ]),
          { status: 200 },
        ),
    );
    const signed = await supabasePhotoStorage(CONFIG, impl).signedUrls(["a.webp", "gone.webp"], 86_400);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ expiresIn: 86_400, paths: ["a.webp", "gone.webp"] });
    expect([...signed]).toEqual([
      ["a.webp", "https://project.supabase.co/storage/v1/object/sign/work-photos/a.webp?token=1"],
    ]);
  });

  it("removes many objects in one call, and nothing for an empty list", async () => {
    const { impl, calls } = fakeFetch(() => new Response("[]", { status: 200 }));
    const storage = supabasePhotoStorage(CONFIG, impl);
    await storage.remove([]);
    expect(calls).toHaveLength(0);

    await storage.remove(["a.webp", "b.webp"]);
    expect(calls[0].url).toBe("https://project.supabase.co/storage/v1/object/work-photos");
    expect(calls[0].init.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ prefixes: ["a.webp", "b.webp"] });
  });

  it("fails loudly, without the key in the message", async () => {
    const { impl } = fakeFetch(() => new Response("nope", { status: 403 }));
    const failure = await supabasePhotoStorage(CONFIG, impl)
      .put("a.webp", new Uint8Array([1]), "image/webp")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PhotoStorageError);
    expect((failure as Error).message).toBe("photo storage upload failed with 403");
    expect((failure as Error).message).not.toContain("service-role-secret");
  });
});

describe("the filesystem driver", () => {
  let directory: string | null = null;
  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it("keeps, reads back and removes a file, and removing twice is fine", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "photos-"));
    const storage = filesystemPhotoStorage(directory);
    await storage.put(`${ORG}/${VISIT}/${PHOTO}.webp`, new Uint8Array([7, 8]), "image/webp");
    expect(Array.from((await storage.get(`${ORG}/${VISIT}/${PHOTO}.webp`))!)).toEqual([7, 8]);

    await storage.remove([`${ORG}/${VISIT}/${PHOTO}.webp`]);
    await storage.remove([`${ORG}/${VISIT}/${PHOTO}.webp`]);
    expect(await storage.get(`${ORG}/${VISIT}/${PHOTO}.webp`)).toBeNull();
  });

  it("refuses a path that leaves its directory", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "photos-"));
    await expect(filesystemPhotoStorage(directory).put("../escape.webp", new Uint8Array([1]), "image/webp")).rejects.toThrow();
  });
});

describe("getPhotoStorageConfig", () => {
  const names = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WORK_PHOTOS_BUCKET", "PHOTO_STORAGE", "PHOTO_STORAGE_DIR"];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  afterEach(() => {
    for (const name of names) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });
  function set(values: Record<string, string | undefined>) {
    for (const name of names) delete process.env[name];
    for (const [name, value] of Object.entries(values)) if (value !== undefined) process.env[name] = value;
  }

  it("is off with nothing set — never the local disk by default", () => {
    set({});
    expect(getPhotoStorageConfig()).toBeNull();
  });

  it("is Supabase with the URL and the key, in the default bucket", () => {
    set({ SUPABASE_URL: "https://abc.supabase.co/", SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(getPhotoStorageConfig()).toEqual({
      kind: "supabase",
      url: "https://abc.supabase.co",
      serviceRoleKey: "k",
      bucket: "work-photos",
    });
  });

  it("refuses half of the pair and a URL that is not an https origin", () => {
    set({ SUPABASE_URL: "https://abc.supabase.co" });
    expect(() => getPhotoStorageConfig()).toThrow(/together/);
    set({ SUPABASE_URL: "http://abc.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" });
    expect(() => getPhotoStorageConfig()).toThrow(/https origin/);
  });

  it("is the local directory when named, even beside a bucket the same .env describes", () => {
    // Regression: a test server read the production bucket from `.env` and
    // tried to upload a test photo into it, past PHOTO_STORAGE=filesystem.
    set({
      PHOTO_STORAGE: "filesystem",
      SUPABASE_URL: "https://abc.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    expect(getPhotoStorageConfig()).toEqual({ kind: "filesystem", directory: ".photo-storage" });
  });

  it("treats an emptied bucket as none at all", () => {
    set({ SUPABASE_URL: "", SUPABASE_SERVICE_ROLE_KEY: "" });
    expect(getPhotoStorageConfig()).toBeNull();
  });

  it("is the local directory only when asked for by name", () => {
    set({ PHOTO_STORAGE: "filesystem", PHOTO_STORAGE_DIR: "/tmp/p" });
    expect(getPhotoStorageConfig()).toEqual({ kind: "filesystem", directory: "/tmp/p" });
  });
});
