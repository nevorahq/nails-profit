/**
 * How much of the work a studio may photograph, roadmap phase 8.
 *
 * Decided 06.10.2026, before the tariffs were: one gigabyte for every studio,
 * four photos per visit. The browser re-encodes each photo to WebP at 1280 px
 * on the long side and aims under 300 KB, so a gigabyte is about four thousand
 * of them — a busy master photographing half her visits for a couple of years.
 * When plans exist, the quota becomes a function of the plan and nothing else
 * here moves.
 */
export const MAX_PHOTOS_PER_VISIT = 4;
export const STUDIO_PHOTO_QUOTA_BYTES = 1024 * 1024 * 1024;
/** What the server accepts; the browser aims far below it. The column's check says the same. */
export const MAX_PHOTO_BYTES = 512 * 1024;
/** The long edge the browser scales to, and the largest the server accepts as stated. */
export const PHOTO_EDGE_PIXELS = 1280;
export const MAX_PHOTO_DIMENSION = 4096;

export type PhotoRefusal = "visit_full" | "quota_exceeded";

/** Why another photo may not be added, or null when it may. */
export function photoUploadRefusal(input: {
  photosOnVisit: number;
  studioBytes: number;
  incomingBytes: number;
}): PhotoRefusal | null {
  if (input.photosOnVisit >= MAX_PHOTOS_PER_VISIT) return "visit_full";
  if (input.studioBytes + input.incomingBytes > STUDIO_PHOTO_QUOTA_BYTES) return "quota_exceeded";
  return null;
}

/**
 * The size to draw a photo at so its long edge is at most `edge`, never
 * enlarged. Used by the browser before encoding.
 */
export function scaledToEdge(width: number, height: number, edge = PHOTO_EDGE_PIXELS) {
  const scale = Math.min(1, edge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}
