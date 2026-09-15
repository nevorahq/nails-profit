import { AVATAR_EDGE_PIXELS, squareCrop } from "@/domain/avatar-image";

/**
 * The centre square of a picture, at the size the interface actually draws.
 *
 * Browser-only: it needs a canvas. A phone photograph is four megabytes of a
 * room and what is drawn is a circle a few dozen pixels across, so the file is
 * re-encoded before it is sent. The endpoint would refuse the four megabytes
 * correctly and uselessly — the owner would learn that their picture is "too
 * large" and have nowhere to make it smaller.
 *
 * WebP first because it is a third of the bytes at the same quality, PNG when
 * the browser cannot encode one — `toBlob` answers with a PNG rather than
 * failing when it does not know the type asked for, so the result is checked
 * instead of assumed. Both are formats the endpoints read from the signature,
 * so whichever arrives is stored as what it is.
 *
 * Shared by the master's face and the studio's mark, which crop the same way
 * for the same reason: an uploaded picture that is not square would otherwise
 * be cut to one by CSS, and stored at a size nobody ever sees.
 */
export async function squareImage(file: File, name: string): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const crop = squareCrop(bitmap.width, bitmap.height);

  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_EDGE_PIXELS;
  canvas.height = AVATAR_EDGE_PIXELS;

  const context = canvas.getContext("2d");
  if (!context) throw new Error("This browser has no 2d canvas");
  context.drawImage(
    bitmap,
    crop.x,
    crop.y,
    crop.size,
    crop.size,
    0,
    0,
    AVATAR_EDGE_PIXELS,
    AVATAR_EDGE_PIXELS,
  );
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.85));
  if (!blob) throw new Error("This browser encoded nothing");

  const extension = blob.type === "image/webp" ? "webp" : "png";
  return new File([blob], `${name}.${extension}`, { type: blob.type });
}
