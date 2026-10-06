import { describe, expect, it } from "vitest";

import {
  MAX_PHOTOS_PER_VISIT,
  photoUploadRefusal,
  scaledToEdge,
  STUDIO_PHOTO_QUOTA_BYTES,
} from "@/domain/visit-photos";

describe("photoUploadRefusal", () => {
  it("lets a photo in while there is room on the visit and in the studio", () => {
    expect(photoUploadRefusal({ photosOnVisit: 0, studioBytes: 0, incomingBytes: 250_000 })).toBeNull();
  });

  it("stops at four photos on one visit", () => {
    expect(MAX_PHOTOS_PER_VISIT).toBe(4);
    expect(photoUploadRefusal({ photosOnVisit: 3, studioBytes: 0, incomingBytes: 1 })).toBeNull();
    expect(photoUploadRefusal({ photosOnVisit: 4, studioBytes: 0, incomingBytes: 1 })).toBe("visit_full");
  });

  it("stops at the studio's gigabyte, counting the photo being added", () => {
    expect(STUDIO_PHOTO_QUOTA_BYTES).toBe(1024 ** 3);
    const nearlyFull = STUDIO_PHOTO_QUOTA_BYTES - 100;
    expect(photoUploadRefusal({ photosOnVisit: 0, studioBytes: nearlyFull, incomingBytes: 100 })).toBeNull();
    expect(photoUploadRefusal({ photosOnVisit: 0, studioBytes: nearlyFull, incomingBytes: 101 })).toBe(
      "quota_exceeded",
    );
  });

  it("names the full visit first when both are true", () => {
    expect(
      photoUploadRefusal({ photosOnVisit: 4, studioBytes: STUDIO_PHOTO_QUOTA_BYTES, incomingBytes: 1 }),
    ).toBe("visit_full");
  });
});

describe("scaledToEdge", () => {
  it("brings the long edge down to 1280, keeping the shape", () => {
    expect(scaledToEdge(4032, 3024)).toEqual({ width: 1280, height: 960 });
    expect(scaledToEdge(3024, 4032)).toEqual({ width: 960, height: 1280 });
  });

  it("never enlarges a small photo", () => {
    expect(scaledToEdge(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
