import { MAX_PHOTO_BYTES, scaledToEdge } from "@/domain/visit-photos";

/** What the browser aims for; the server's ceiling (`MAX_PHOTO_BYTES`) is the hard one. */
const TARGET_BYTES = 300 * 1024;
const QUALITIES = [0.82, 0.72, 0.62, 0.5] as const;

export type EncodedPhoto = Readonly<{ file: File; width: number; height: number }>;

function encode(canvas: HTMLCanvasElement, type: string, quality: number) {
  return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * A phone photograph made into what the studio keeps: the long edge at 1280 px
 * and the file under 300 KB.
 *
 * Browser-only: it needs a canvas. Four to five megabytes come off a phone, and
 * sending that over a mobile connection to be shrunk on the server would cost
 * the master half a minute per photo and the studio its quota for nothing.
 *
 * WebP first, stepping the quality down until it fits. A browser that cannot
 * encode WebP answers `toBlob` with a PNG, and a PNG of a photograph at this
 * size is megabytes, so that browser gets JPEG instead — never the PNG.
 */
export async function encodeWorkPhoto(source: File): Promise<EncodedPhoto> {
  const bitmap = await createImageBitmap(source);
  const size = scaledToEdge(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser has no 2d canvas");
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  bitmap.close();

  let type = "image/webp";
  let smallest: Blob | null = null;
  for (const quality of QUALITIES) {
    let blob = await encode(canvas, type, quality);
    if (blob && blob.type !== type) {
      type = "image/jpeg";
      blob = await encode(canvas, type, quality);
    }
    if (!blob) continue;
    if (!smallest || blob.size < smallest.size) smallest = blob;
    if (blob.size <= TARGET_BYTES) break;
  }

  if (!smallest || smallest.size > MAX_PHOTO_BYTES) throw new Error("The photo could not be made small enough");
  const extension = smallest.type === "image/webp" ? "webp" : "jpg";
  return {
    file: new File([smallest], `work.${extension}`, { type: smallest.type }),
    width: size.width,
    height: size.height,
  };
}
