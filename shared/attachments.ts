// Files attached to a phone message (#48): limits shared by the browser's picker/paste and the server's re-check, the
// clean name files are stored under, reading a file's kind from its bytes, and the block appended to the CEO's text
// so its Read tool knows what to open. Images are re-encoded in the browser first (ui/attachments.ts); everything
// else (documents, video) travels unchanged, so the server is the only gate for those.

export type AttachmentKind = 'image' | 'video' | 'doc';

/** Most files on one message. */
export const MAX_FILES = 5;

/** An image's long edge, in pixels, once the browser has re-encoded it. */
export const MAX_IMAGE_EDGE = 2000;

/** 3.75 MB of bytes is <= 5 MB once base64-encoded: Anthropic's per-image API cap, comfortably within OpenAI's. */
export const IMAGE_MAX_BYTES = Math.floor(3.75 * 1024 * 1024);
export const VIDEO_MAX_BYTES = 100 * 1024 * 1024;
export const PDF_MAX_BYTES = 32 * 1024 * 1024;
export const TEXT_MAX_BYTES = 5 * 1024 * 1024;
/** docx / xlsx / pptx. */
export const OFFICE_MAX_BYTES = 25 * 1024 * 1024;

/** A magic-byte family the server checks a file's header against. */
export type Magic = 'jpeg' | 'png' | 'webp' | 'pdf' | 'zip' | 'mp4' | 'webm';

interface TypeRule {
  kind: AttachmentKind;
  maxBytes: number;
  mime: string;
  /** Checked against the file's actual bytes (sniff); absent for plain text, checked for valid UTF-8 instead. */
  magic?: Magic;
}

const IMAGE_RULES: Record<string, TypeRule> = {
  '.jpg': { kind: 'image', maxBytes: IMAGE_MAX_BYTES, mime: 'image/jpeg', magic: 'jpeg' },
  '.jpeg': { kind: 'image', maxBytes: IMAGE_MAX_BYTES, mime: 'image/jpeg', magic: 'jpeg' },
  '.png': { kind: 'image', maxBytes: IMAGE_MAX_BYTES, mime: 'image/png', magic: 'png' },
  '.webp': { kind: 'image', maxBytes: IMAGE_MAX_BYTES, mime: 'image/webp', magic: 'webp' },
};
const VIDEO_RULES: Record<string, TypeRule> = {
  '.mp4': { kind: 'video', maxBytes: VIDEO_MAX_BYTES, mime: 'video/mp4', magic: 'mp4' },
  '.mov': { kind: 'video', maxBytes: VIDEO_MAX_BYTES, mime: 'video/quicktime', magic: 'mp4' },
  '.webm': { kind: 'video', maxBytes: VIDEO_MAX_BYTES, mime: 'video/webm', magic: 'webm' },
};
const DOC_RULES: Record<string, TypeRule> = {
  '.pdf': { kind: 'doc', maxBytes: PDF_MAX_BYTES, mime: 'application/pdf', magic: 'pdf' },
  '.docx': { kind: 'doc', maxBytes: OFFICE_MAX_BYTES, mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', magic: 'zip' },
  '.xlsx': { kind: 'doc', maxBytes: OFFICE_MAX_BYTES, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', magic: 'zip' },
  '.pptx': { kind: 'doc', maxBytes: OFFICE_MAX_BYTES, mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', magic: 'zip' },
};
/** Everything else is kept as plain text: its only real gate is valid UTF-8 (checkText), whatever the extension. */
const TEXT_RULE: TypeRule = { kind: 'doc', maxBytes: TEXT_MAX_BYTES, mime: 'text/plain' };

const RULES: Record<string, TypeRule> = { ...IMAGE_RULES, ...VIDEO_RULES, ...DOC_RULES };

const ext = (name: string) => {
  const m = /\.[^.\\/]+$/.exec(name);
  return m ? m[0].toLowerCase() : '';
};

/** The rule a file name maps to: a known image/video/office/pdf extension, else plain text. */
export const ruleFor = (name: string): TypeRule => RULES[ext(name)] ?? TEXT_RULE;

/** What AttachmentView.kind this file name is. */
export const kindOf = (name: string): AttachmentKind => ruleFor(name).kind;

/** The basename, kept to characters a path and a URL are both happy with, at most 80 of them, never empty. Cutting to
 * length keeps the extension (so the CEO's Read, and any kind-by-extension check, still sees a .pdf or .png). */
export function cleanName(name: string): string {
  const base = name.replace(/^.*[\\/]/, '').trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, '_');
  const trimmed = (() => {
    if (cleaned.length <= 80) return cleaned;
    const e = ext(cleaned);
    // Only keep a short, known extension: an overlong or junk ".suffix" is just truncated with everything else.
    if (e && e.length <= 10 && e.length < 80) return cleaned.slice(0, 80 - e.length) + e;
    return cleaned.slice(0, 80);
  })();
  return /[A-Za-z0-9]/.test(trimmed) ? trimmed : 'file';
}

/** A human size: "240 KB", "1.4 MB". */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface AttachmentProblem {
  status: 400 | 413 | 415;
  message: string;
}

/** Why a file can't be attached by its name, claimed type and size — the one check the browser can make before it
 * has read the bytes. The server re-checks the bytes themselves (magic, UTF-8, image dimensions) separately. */
export function attachmentProblem(file: { name: string; size: number }): AttachmentProblem | null {
  if (!(file.size > 0)) return { status: 400, message: `${file.name || 'That file'} is empty.` };
  const rule = ruleFor(file.name);
  if (file.size > rule.maxBytes) return { status: 413, message: `${file.name} is too big: ${humanSize(file.size)}, the limit for this kind of file is ${humanSize(rule.maxBytes)}.` };
  return null;
}

/** Why a message's attachments can't go out: too many files, or one of them individually refused. */
export function attachmentsProblem(files: { name: string; size: number }[]): AttachmentProblem | null {
  if (files.length > MAX_FILES) return { status: 400, message: `Up to ${MAX_FILES} files per message.` };
  for (const f of files) {
    const p = attachmentProblem(f);
    if (p) return p;
  }
  return null;
}

// ---------- reading bytes (the server's re-check) ----------

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

/** The magic-byte family a file's header matches, or null when it matches none the office knows. */
export function sniff(buf: Uint8Array): Magic | null {
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, ascii('RIFF')) && startsWith(buf, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(buf, ascii('%PDF'))) return 'pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06]) || startsWith(buf, [0x50, 0x4b, 0x07, 0x08])) return 'zip';
  if (buf.length >= 12 && startsWith(buf, ascii('ftyp'), 4)) return 'mp4';
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) return 'webm';
  return null;
}

/** Whether `buf` is valid UTF-8 text with no NUL byte (clipLimits-style plain check, no library). */
export function isText(buf: Uint8Array): boolean {
  let i = 0;
  while (i < buf.length) {
    const b = buf[i];
    if (b === 0x00) return false;
    if (b < 0x80) {
      i += 1;
      continue;
    }
    let need: number;
    let min: number;
    if ((b & 0xe0) === 0xc0) {
      need = 1;
      min = 0x80;
    } else if ((b & 0xf0) === 0xe0) {
      need = 2;
      min = 0x800;
    } else if ((b & 0xf8) === 0xf0) {
      need = 3;
      min = 0x10000;
    } else return false;
    if (i + need >= buf.length) return false;
    let cp = b & (0x3f >> need);
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if ((c & 0xc0) !== 0x80) return false;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return false;
    i += need + 1;
  }
  return true;
}

/** An image's pixel size read straight from its header (PNG, JPEG, WebP), without decoding it; null when it can't be read. */
export function imageSize(buf: Uint8Array): { width: number; height: number } | null {
  const u32 = (o: number) => (buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3];
  const u16 = (o: number) => (buf[o] << 8) | buf[o + 1];
  if (sniff(buf) === 'png' && buf.length >= 24) return { width: u32(16) >>> 0, height: u32(20) >>> 0 };
  if (sniff(buf) === 'jpeg') {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      const len = u16(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: u16(i + 5), width: u16(i + 7) };
      i += 2 + len;
    }
    return null;
  }
  if (sniff(buf) === 'webp' && buf.length >= 30) {
    const chunk = String.fromCharCode(buf[12], buf[13], buf[14], buf[15]);
    if (chunk === 'VP8X') return { width: (buf[24] | (buf[25] << 8) | (buf[26] << 16)) + 1, height: (buf[27] | (buf[28] << 8) | (buf[29] << 16)) + 1 };
    if (chunk === 'VP8 ' && buf.length >= 30 && buf[23] === 0x9d && buf[24] === 0x01 && buf[25] === 0x2a) return { width: (u16(26) & 0x3fff) >>> 0, height: (u16(28) & 0x3fff) >>> 0 };
    if (chunk === 'VP8L' && buf.length >= 25 && buf[20] === 0x2f) {
      const bits = buf[21] | (buf[22] << 8) | (buf[23] << 16) | (buf[24] << 24);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  return null;
}

/** One file as the server read it: enough to re-check it against `ruleFor(name)`. */
export interface AttachmentRead {
  name: string;
  size: number;
  buf: Uint8Array;
}

/** Why a file the server has the bytes for can't be kept, or null when it's fine. */
export function checkAttachment(file: AttachmentRead): AttachmentProblem | null {
  const basic = attachmentProblem(file);
  if (basic) return basic;
  const rule = ruleFor(file.name);
  if (rule.magic) {
    if (sniff(file.buf) !== rule.magic) return { status: 415, message: `${file.name} doesn't look like a valid ${rule.kind === 'doc' ? 'document' : rule.kind}: its content doesn't match its name.` };
    if (rule.kind === 'image') {
      const size = imageSize(file.buf);
      if (!size) return { status: 415, message: `${file.name}'s image data couldn't be read.` };
      if (size.width > MAX_IMAGE_EDGE || size.height > MAX_IMAGE_EDGE) return { status: 413, message: `${file.name} is ${size.width}×${size.height}: the long edge must be ${MAX_IMAGE_EDGE}px or less.` };
    }
  } else if (!isText(file.buf)) {
    return { status: 415, message: `${file.name} isn't a text file the office recognises (and isn't a PDF, Office document or video either).` };
  }
  return null;
}

// ---------- what the manager and the CEO see ----------

export interface AttachmentInfo {
  name: string;
  mime: string;
  kind: AttachmentKind;
  size: number;
  width?: number;
  height?: number;
}

/** One line of the block appended to the CEO's text, e.g. "- /home/.../photo.png — image/png, 1600×1200, 820 KB". */
function attachmentLine(path: string, a: AttachmentInfo): string {
  const dims = a.width && a.height ? `, ${a.width}×${a.height}` : '';
  const note = a.kind === 'video' ? ' — you can\'t watch video; say so if it matters' : '';
  return `- ${path} — ${a.mime}${dims}, ${humanSize(a.size)}${note}`;
}

/** The block appended to the CEO's message text so its Read tool knows what files it was sent and where they are. */
export function attachedBlock(files: { path: string; info: AttachmentInfo }[]): string {
  if (files.length === 0) return '';
  return ['Attached files (open each with your Read tool before you answer):', ...files.map((f) => attachmentLine(f.path, f.info))].join('\n');
}
