import { describe, expect, test } from "vitest";

import { avatarImageTypeOf } from "@/domain/avatar-image";

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
