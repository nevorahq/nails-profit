/**
 * Real image bytes for the tests that upload one.
 *
 * The avatar endpoint reads the format from the file's signature rather than
 * from the part's content type, so `new File(["x"], "a.png")` is refused there
 * exactly as it should be. This is the smallest file that genuinely is what it
 * says: a 1×1 transparent PNG, verified by decoding it.
 */
export const PNG_PIXEL = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
