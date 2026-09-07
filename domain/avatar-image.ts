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
