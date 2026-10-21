import { describe, expect, it } from 'vitest';
import {
  attachedBlock,
  attachmentProblem,
  attachmentsProblem,
  checkAttachment,
  cleanName,
  IMAGE_MAX_BYTES,
  imageSize,
  isText,
  kindOf,
  MAX_FILES,
  sniff,
  TEXT_MAX_BYTES,
} from './attachments.ts';

// A minimal PNG header: signature + IHDR with a given width/height, long enough for imageSize to read.
function pngHeader(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0, 0, 0, 13], 8); // IHDR length
  buf.set([0x49, 0x48, 0x44, 0x52], 12); // "IHDR"
  const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  buf.set(u32(width), 16);
  buf.set(u32(height), 20);
  return buf;
}

describe('kindOf', () => {
  it('reads image, video and office extensions', () => {
    expect(kindOf('photo.PNG')).toBe('image');
    expect(kindOf('clip.webm')).toBe('video');
    expect(kindOf('report.pdf')).toBe('doc');
    expect(kindOf('sheet.xlsx')).toBe('doc');
  });

  it('treats anything unrecognised as text (its only gate is valid UTF-8)', () => {
    expect(kindOf('notes.md')).toBe('doc');
    expect(kindOf('weird.exe')).toBe('doc');
    expect(kindOf('noext')).toBe('doc');
  });
});

describe('cleanName', () => {
  it('keeps the basename, drops a directory', () => {
    expect(cleanName('/tmp/foo/bar.png')).toBe('bar.png');
    expect(cleanName('C:\\Users\\me\\bar.png')).toBe('bar.png');
  });

  it('replaces characters outside [A-Za-z0-9._-] and caps the length', () => {
    expect(cleanName('my photo (1).png')).toBe('my_photo__1_.png');
    expect(cleanName('a'.repeat(100) + '.txt')).toHaveLength(80);
  });

  it('never returns empty', () => {
    expect(cleanName('')).toBe('file');
    expect(cleanName('***')).toBe('file');
  });
});

describe('attachmentProblem / attachmentsProblem', () => {
  it('takes a file within its kind\'s size cap', () => {
    expect(attachmentProblem({ name: 'a.png', size: IMAGE_MAX_BYTES })).toBeNull();
    expect(attachmentProblem({ name: 'a.txt', size: TEXT_MAX_BYTES })).toBeNull();
  });

  it('refuses an empty file', () => {
    expect(attachmentProblem({ name: 'a.png', size: 0 })?.status).toBe(400);
  });

  it('refuses a file over its kind\'s cap, naming the cap', () => {
    const p = attachmentProblem({ name: 'a.png', size: IMAGE_MAX_BYTES + 1 });
    expect(p?.status).toBe(413);
    expect(p?.message).toContain('a.png');
  });

  it('refuses more than MAX_FILES', () => {
    const files = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ name: `f${i}.txt`, size: 10 }));
    expect(attachmentsProblem(files)?.status).toBe(400);
  });

  it('takes exactly MAX_FILES', () => {
    const files = Array.from({ length: MAX_FILES }, (_, i) => ({ name: `f${i}.txt`, size: 10 }));
    expect(attachmentsProblem(files)).toBeNull();
  });
});

describe('sniff', () => {
  it('recognises PNG, JPEG, PDF, zip and ftyp/EBML headers', () => {
    expect(sniff(pngHeader(1, 1))).toBe('png');
    expect(sniff(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniff(new TextEncoder().encode('%PDF-1.4'))).toBe('pdf');
    expect(sniff(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe('zip');
    expect(sniff(new Uint8Array([0, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]))).toBe('mp4');
    expect(sniff(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]))).toBe('webm');
  });

  it('returns null for bytes matching nothing it knows', () => {
    expect(sniff(new TextEncoder().encode('just some text'))).toBeNull();
  });
});

describe('isText', () => {
  it('accepts ASCII and multi-byte UTF-8', () => {
    expect(isText(new TextEncoder().encode('hello, "café" — 日本語'))).toBe(true);
  });

  it('refuses a NUL byte and invalid UTF-8', () => {
    expect(isText(new Uint8Array([104, 105, 0, 33]))).toBe(false);
    expect(isText(new Uint8Array([0xff, 0xfe, 0x00]))).toBe(false);
  });
});

describe('imageSize', () => {
  it('reads a PNG header', () => {
    expect(imageSize(pngHeader(4000, 3000))).toEqual({ width: 4000, height: 3000 });
  });

  it('returns null for bytes it cannot read', () => {
    expect(imageSize(new TextEncoder().encode('not an image'))).toBeNull();
  });
});

describe('checkAttachment', () => {
  it('refuses an image whose bytes do not match its claimed name (wrong magic)', () => {
    const buf = new TextEncoder().encode('not a png at all, just text');
    const p = checkAttachment({ name: 'photo.png', size: buf.length, buf });
    expect(p?.status).toBe(415);
  });

  it('refuses an oversized image by dimensions even if small in bytes', () => {
    const buf = pngHeader(4000, 3000);
    const p = checkAttachment({ name: 'photo.png', size: buf.length, buf });
    expect(p).toEqual(expect.objectContaining({ status: 413 }));
    expect(p?.message).toContain('4000');
  });

  it('takes a PNG within the size cap', () => {
    const buf = pngHeader(1200, 800);
    expect(checkAttachment({ name: 'photo.png', size: buf.length, buf })).toBeNull();
  });

  it('takes a plain-text file of any extension when its bytes are valid UTF-8', () => {
    const buf = new TextEncoder().encode('console.log("hi")');
    expect(checkAttachment({ name: 'script.js', size: buf.length, buf })).toBeNull();
  });

  it('refuses a binary file masquerading as text (e.g. a renamed .exe)', () => {
    const buf = new Uint8Array([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]);
    const p = checkAttachment({ name: 'app.exe', size: buf.length, buf });
    expect(p?.status).toBe(415);
  });

  it('refuses a PDF whose header is forged', () => {
    const buf = new TextEncoder().encode('definitely not a pdf');
    expect(checkAttachment({ name: 'doc.pdf', size: buf.length, buf })?.status).toBe(415);
  });
});

describe('attachedBlock', () => {
  it('is empty with no files', () => {
    expect(attachedBlock([])).toBe('');
  });

  it('lists each file with its path, type, dimensions and size', () => {
    const block = attachedBlock([{ path: '/ceo/attachments/1-photo.png', info: { name: 'photo.png', mime: 'image/png', kind: 'image', size: 240_000, width: 1600, height: 1200 } }]);
    expect(block).toContain('Attached files');
    expect(block).toContain('/ceo/attachments/1-photo.png — image/png, 1600×1200, 234 KB');
  });

  it("notes that video can't be watched", () => {
    const block = attachedBlock([{ path: '/ceo/attachments/2-clip.mp4', info: { name: 'clip.mp4', mime: 'video/mp4', kind: 'video', size: 1_000_000 } }]);
    expect(block).toContain("you can't watch video");
  });
});
