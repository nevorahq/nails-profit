import { describe, expect, test } from "vitest";

import { avatarImageTypeOf, avatarUrl, organizationLogoUrl, squareCrop } from "@/domain/avatar-image";

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function ascii(text: string): number[] {
  return [...text].map((character) => character.charCodeAt(0));
}

describe("avatarImageTypeOf", () => {
  test("reads a PNG by its signature", () => {
    expect(avatarImageTypeOf(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe("image/png");
  });

  test("reads a JPEG by its start-of-image marker", () => {
    expect(avatarImageTypeOf(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe("image/jpeg");
  });

  test("reads a WebP past the length its RIFF header carries", () => {
    expect(avatarImageTypeOf(bytes(...ascii("RIFF"), 0x24, 0x01, 0x00, 0x00, ...ascii("WEBP")))).toBe("image/webp");
  });

  test("a RIFF container that is not WebP is not an image we take", () => {
    // The same header a .wav file starts with.
    expect(avatarImageTypeOf(bytes(...ascii("RIFF"), 0x24, 0x01, 0x00, 0x00, ...ascii("WAVE")))).toBeNull();
  });

  test("refuses SVG, which is markup however it is labelled", () => {
    expect(avatarImageTypeOf(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
  });

  test("refuses a GIF", () => {
    expect(avatarImageTypeOf(bytes(...ascii("GIF89a"), 0x01, 0x00))).toBeNull();
  });

  test("does not read past the end of a truncated file", () => {
    expect(avatarImageTypeOf(bytes(0x89, 0x50, 0x4e))).toBeNull();
    expect(avatarImageTypeOf(bytes(...ascii("RIFF"), 0x00))).toBeNull();
    expect(avatarImageTypeOf(bytes())).toBeNull();
  });
});

describe("squareCrop", () => {
  test("a square photo is taken whole", () => {
    expect(squareCrop(512, 512)).toEqual({ x: 0, y: 0, size: 512 });
  });

  test("a landscape photo is cropped from the middle", () => {
    expect(squareCrop(1000, 400)).toEqual({ x: 300, y: 0, size: 400 });
  });

  test("a portrait photo is cropped above the middle, where a face is", () => {
    const crop = squareCrop(400, 1000);
    expect(crop.size).toBe(400);
    expect(crop.x).toBe(0);
    expect(crop.y).toBe(200);
    // Above centre, and inside the image.
    expect(crop.y).toBeLessThan((1000 - 400) / 2);
    expect(crop.y + crop.size).toBeLessThanOrEqual(1000);
  });

  test("never leaves the image, whatever the proportions", () => {
    for (const [width, height] of [[3, 4000], [4000, 3], [1, 1], [1023, 767]] as const) {
      const crop = squareCrop(width, height);
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.size).toBeLessThanOrEqual(width);
      expect(crop.y + crop.size).toBeLessThanOrEqual(height);
    }
  });
});

describe("avatarUrl", () => {
  test("a card with no photo has no address", () => {
    expect(avatarUrl("6f2b", null)).toBeNull();
  });

  test("carries the version, so a replacement is not the cached one", () => {
    expect(avatarUrl("6f2b", 3)).toBe("/api/v1/specialists/6f2b/avatar?v=3");
    expect(avatarUrl("6f2b", 3)).not.toBe(avatarUrl("6f2b", 4));
  });
});

describe("organizationLogoUrl", () => {
  test("a studio with no mark has no address, which is what draws the flower", () => {
    expect(organizationLogoUrl(null)).toBeNull();
  });

  test("carries the version, so a replaced mark is not the cached one", () => {
    expect(organizationLogoUrl(2)).toBe("/api/v1/organizations/logo?v=2");
    expect(organizationLogoUrl(2)).not.toBe(organizationLogoUrl(3));
  });

  // Unlike a face, which is addressed by the card it belongs to, this address
  // carries no studio at all: the route reads the organization from the
  // session, so there is no id here for a caller to swap for someone else's.
  test("names no studio — the session alone decides whose mark is served", () => {
    const [path] = (organizationLogoUrl(9) as string).split("?");
    expect(path).toBe("/api/v1/organizations/logo");
  });
});
