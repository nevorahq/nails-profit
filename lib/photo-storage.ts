import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { getPhotoStorageConfig, type PhotoStorageConfig } from "@/env";

/**
 * Where the bytes of a photo of work live, behind one small interface.
 *
 * The rows say which photos exist (`visit_photo`); this keeps the files. Three
 * drivers, chosen by `getPhotoStorageConfig`:
 *
 * - Supabase Storage, over its REST API rather than the SDK: the four calls
 *   needed here are plain HTTP, and a client library would be a dependency for
 *   them. The bucket is private and the service-role key never leaves the
 *   server; a browser only ever sees a signed link that expires.
 * - a directory on disk, for local development and the browser suite;
 * - memory, installed by the tests with `setPhotoStorage`.
 *
 * Every path is `<organization>/<visit>/<photo>.<ext>`, built here and nowhere
 * else, so a studio's objects are one prefix and nothing a caller sends can
 * reach outside it.
 */
export type PhotoStorage = Readonly<{
  name: "supabase" | "filesystem" | "memory";
  put(storagePath: string, bytes: Uint8Array, mimeType: string): Promise<void>;
  /** Bytes for the drivers that serve them through the application. */
  get(storagePath: string): Promise<Uint8Array | null>;
  /**
   * A link a browser can load the photo from for `expiresInSeconds`, or null
   * when the driver serves the bytes itself (then the caller streams `get`).
   */
  signedUrl(storagePath: string, expiresInSeconds: number): Promise<string | null>;
  /** The same for many paths in one call — the export signs a studio's whole archive. */
  signedUrls(storagePaths: readonly string[], expiresInSeconds: number): Promise<Map<string, string>>;
  /** Removing what is already gone succeeds: deletions are retried. */
  remove(storagePaths: readonly string[]): Promise<void>;
}>;

const EXTENSIONS: Record<string, string> = {
  "image/webp": "webp",
  "image/jpeg": "jpg",
  "image/png": "png",
};

export function photoStoragePath(
  organizationId: string,
  visitId: string,
  photoId: string,
  mimeType: string,
): string {
  const uuid = /^[0-9a-f-]{36}$/;
  if (![organizationId, visitId, photoId].every((part) => uuid.test(part))) {
    throw new Error("photo storage paths are built from ids only");
  }
  const extension = EXTENSIONS[mimeType];
  if (!extension) throw new Error(`no extension for ${mimeType}`);
  return `${organizationId}/${visitId}/${photoId}.${extension}`;
}

/** Thrown for any answer from Storage other than success; the message carries no key. */
export class PhotoStorageError extends Error {
  constructor(
    readonly operation: string,
    readonly status: number,
  ) {
    super(`photo storage ${operation} failed with ${status}`);
    this.name = "PhotoStorageError";
  }
}

function encodePath(storagePath: string) {
  return storagePath.split("/").map(encodeURIComponent).join("/");
}

export function supabasePhotoStorage(
  config: Extract<PhotoStorageConfig, { kind: "supabase" }>,
  fetchImpl: typeof fetch = fetch,
): PhotoStorage {
  const base = `${config.url}/storage/v1`;
  const headers = { authorization: `Bearer ${config.serviceRoleKey}`, apikey: config.serviceRoleKey };

  return {
    name: "supabase",
    async put(storagePath, bytes, mimeType) {
      const response = await fetchImpl(`${base}/object/${config.bucket}/${encodePath(storagePath)}`, {
        method: "POST",
        headers: { ...headers, "content-type": mimeType, "cache-control": "max-age=3600", "x-upsert": "false" },
        body: bytes as unknown as BodyInit,
      });
      if (!response.ok) throw new PhotoStorageError("upload", response.status);
    },
    async get() {
      // Served by signed link; the application never relays the bytes.
      return null;
    },
    async signedUrl(storagePath, expiresInSeconds) {
      const response = await fetchImpl(`${base}/object/sign/${config.bucket}/${encodePath(storagePath)}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ expiresIn: expiresInSeconds }),
      });
      if (!response.ok) throw new PhotoStorageError("sign", response.status);
      const body = (await response.json()) as { signedURL?: string };
      if (!body.signedURL) throw new PhotoStorageError("sign", response.status);
      return `${base}${body.signedURL.startsWith("/") ? "" : "/"}${body.signedURL}`;
    },
    async signedUrls(storagePaths, expiresInSeconds) {
      const signed = new Map<string, string>();
      // Batches of a thousand: one request for a typical studio's archive, and
      // no single body large enough to be refused.
      for (let start = 0; start < storagePaths.length; start += 1_000) {
        const batch = storagePaths.slice(start, start + 1_000);
        const response = await fetchImpl(`${base}/object/sign/${config.bucket}`, {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify({ expiresIn: expiresInSeconds, paths: batch }),
        });
        if (!response.ok) throw new PhotoStorageError("sign", response.status);
        const rows = (await response.json()) as { path?: string; signedURL?: string | null }[];
        for (const row of rows) {
          if (row.path && row.signedURL) {
            signed.set(row.path, `${base}${row.signedURL.startsWith("/") ? "" : "/"}${row.signedURL}`);
          }
        }
      }
      return signed;
    },
    async remove(storagePaths) {
      if (storagePaths.length === 0) return;
      const response = await fetchImpl(`${base}/object/${config.bucket}`, {
        method: "DELETE",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ prefixes: storagePaths }),
      });
      if (!response.ok) throw new PhotoStorageError("delete", response.status);
    },
  };
}

export function filesystemPhotoStorage(directory: string): PhotoStorage {
  const root = path.resolve(directory);
  const fileOf = (storagePath: string) => {
    const file = path.resolve(root, storagePath);
    if (!file.startsWith(root + path.sep)) throw new Error("path escapes the photo directory");
    return file;
  };

  return {
    name: "filesystem",
    async put(storagePath, bytes) {
      const file = fileOf(storagePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async get(storagePath) {
      return readFile(fileOf(storagePath)).catch(() => null);
    },
    async signedUrl() {
      return null;
    },
    async signedUrls() {
      return new Map();
    },
    async remove(storagePaths) {
      await Promise.all(storagePaths.map((storagePath) => rm(fileOf(storagePath), { force: true })));
    },
  };
}

export function memoryPhotoStorage(): PhotoStorage & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    name: "memory",
    objects,
    async put(storagePath, bytes) {
      objects.set(storagePath, bytes);
    },
    async get(storagePath) {
      return objects.get(storagePath) ?? null;
    },
    async signedUrl() {
      return null;
    },
    async signedUrls() {
      return new Map();
    },
    async remove(storagePaths) {
      for (const storagePath of storagePaths) objects.delete(storagePath);
    },
  };
}

let override: PhotoStorage | null | undefined;

/** Tests install a driver here; `undefined` goes back to the configured one. */
export function setPhotoStorage(storage: PhotoStorage | null | undefined) {
  override = storage;
}

/** The configured driver, or null when photos are not set up here. */
export function getPhotoStorage(): PhotoStorage | null {
  if (override !== undefined) return override;
  const config = getPhotoStorageConfig();
  if (!config) return null;
  return config.kind === "supabase" ? supabasePhotoStorage(config) : filesystemPhotoStorage(config.directory);
}
