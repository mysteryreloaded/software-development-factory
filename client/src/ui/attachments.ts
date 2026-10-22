import { humanSize, IMAGE_MAX_BYTES, MAX_IMAGE_EDGE } from '../../../shared/attachments';

// Re-encoding a picked image (#48) before it's ever uploaded: a canvas redraw applies EXIF orientation and drops
// metadata (GPS) on its own, so this is only the sizing and format maths; ui/AttachButton.tsx does the actual
// drawing (it needs the DOM) and the rest of a message box's attachment picking, pasting and upload state.

/** The long edge, scaled down to fit `maxEdge`; never scales up. */
export function resizeDims(width: number, height: number, maxEdge = MAX_IMAGE_EDGE): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge || long <= 0) return { width, height };
  const scale = maxEdge / long;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export interface EncodeAttempt {
  mime: 'image/png' | 'image/jpeg';
  quality?: number;
  /** Multiplies the already-resized dimensions, for the last-resort steps. */
  scale: number;
}

/**
 * What to try, in order, until one comes out at or under IMAGE_MAX_BYTES: a PNG screenshot stays PNG first (so it
 * stays sharp); everything else goes straight to JPEG, stepping the quality down and finally shrinking further.
 */
export function encodeAttempts(sourceIsPng: boolean): EncodeAttempt[] {
  const png: EncodeAttempt[] = sourceIsPng ? [{ mime: 'image/png', scale: 1 }] : [];
  return [...png, { mime: 'image/jpeg', quality: 0.85, scale: 1 }, { mime: 'image/jpeg', quality: 0.7, scale: 1 }, { mime: 'image/jpeg', quality: 0.6, scale: 1 }, { mime: 'image/jpeg', quality: 0.6, scale: 0.75 }, { mime: 'image/jpeg', quality: 0.6, scale: 0.5 }];
}

export type NormaliseResult = { blob: Blob; ext: '.png' | '.jpg' } | { error: string };

/** Re-encodes a picked image on a canvas: EXIF orientation applied and metadata dropped by the redraw itself, long
 * edge capped, then shrunk until it fits IMAGE_MAX_BYTES. Accepts anything the browser can decode. */
export async function normaliseImage(file: File): Promise<NormaliseResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  } catch {
    return { error: `${file.name} isn't a picture format this browser can open.` };
  }
  try {
    const base = resizeDims(bitmap.width, bitmap.height);
    for (const step of encodeAttempts(file.type === 'image/png')) {
      const w = Math.max(1, Math.round(base.width * step.scale));
      const h = Math.max(1, Math.round(base.height * step.scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) return { error: "This browser can't redraw images." };
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, step.mime, step.quality));
      if (blob && blob.size <= IMAGE_MAX_BYTES) return { blob, ext: step.mime === 'image/png' ? '.png' : '.jpg' };
    }
    return { error: `${file.name} couldn't be shrunk under ${humanSize(IMAGE_MAX_BYTES)}.` };
  } finally {
    bitmap.close();
  }
}
