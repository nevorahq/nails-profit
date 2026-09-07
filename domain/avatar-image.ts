/**
 * What kind of image these bytes actually are.
 *
 * A multipart part carries whatever content type the browser chose to write,
 * which is to say whatever the caller chose to write. Reading the signature
 * instead makes the question moot: the type stored beside a photo is the one
 * derived from its first bytes, so the row cannot claim to be a PNG while
 * holding something else, and the check constraint in the database is spared a
 * value the application never verified.
 *
 * Three formats, because they are what a browser both encodes to a canvas and
 * decodes in an `<img>`. Anything else — a GIF, an SVG, a TIFF — is refused
 * rather than converted: SVG in particular is a script container, and accepting
 * one to draw a face would be accepting markup that runs where it is drawn.
 */
export const AVATAR_MIME_TYPES = ["image/webp", "image/jpeg", "image/png"] as const;

export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** SOI plus the first marker byte; the fourth varies by encoder. */
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function isAscii(bytes: Uint8Array, text: string, offset: number): boolean {
  return startsWith(bytes, [...text].map((character) => character.charCodeAt(0)), offset);
}

export function avatarImageTypeOf(bytes: Uint8Array): AvatarMimeType | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, JPEG_SIGNATURE)) return "image/jpeg";
  // A RIFF container with WEBP as its form type — the four bytes between the
  // two are the file's own length, which says nothing about the format.
  if (isAscii(bytes, "RIFF", 0) && isAscii(bytes, "WEBP", 8)) return "image/webp";
  return null;
}

/**
 * The square to take out of a photo before it becomes a face.
 *
 * Avatars are drawn in a circle, so a portrait uploaded whole would be shown
 * with its top and bottom cut off by CSS and stored at a size nobody sees. The
 * centre square is cropped before the upload instead: the browser sends the
 * pixels that will be looked at and nothing else.
 *
 * Vertically the crop sits above centre. A photograph of a person puts the face
 * in the upper half, and a centred square through a standing figure is a
 * portrait of a torso — a third of the way down is where a head actually is.
 */
export const AVATAR_EDGE_PIXELS = 256;

export function squareCrop(width: number, height: number): { x: number; y: number; size: number } {
  const size = Math.min(width, height);
  return {
    x: Math.round((width - size) / 2),
    y: Math.round((height - size) / 3),
    size,
  };
}

/**
 * Where a card's photo is fetched from, or null when it has none.
 *
 * The version is in the query string so that replacing a photo replaces the one
 * the browser is holding. The bytes are behind a session and answer a
 * conditional request with a 304, so this is a cache key rather than a cache
 * buster: it changes when the picture does and never otherwise.
 */
export function avatarUrl(specialistId: string, version: number | null): string | null {
  return version === null ? null : `/api/v1/specialists/${specialistId}/avatar?v=${version}`;
}
