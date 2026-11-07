import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// The look tool's pure logic: ask a vision model about one image or one video frame at a time, so the
// agent's own conversation never holds an image (issue #122). Every dependency on the outside world is
// injected, so tests run with a fake fetch and a fake ffmpeg: no network, no real ffmpeg.

export interface Endpoint {
  baseURL: string;
  model: string;
  apiKey?: string;
}

export type FfmpegRunner = (args: string[]) => Promise<{ stdout: string; stderr: string }>;
export type ReadFile = (filePath: string) => Promise<Buffer>;

export interface LookDeps {
  endpoint: Endpoint;
  fetch: typeof fetch;
  ffmpeg: FfmpegRunner;
  readFile: ReadFile;
  tmpDir: string;
}

export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LookAtImageArgs {
  path: string;
  question: string;
  region?: Region;
  zoom?: number;
}

export interface LookAtVideoArgs {
  path: string;
  question: string;
  everySeconds?: number;
  maxFrames?: number;
}

/** Whether the model answered (text has the answer) or the call failed (text is a short reason, never thrown). */
export interface LookResult {
  ok: boolean;
  text: string;
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TIMEOUT_MS = 120_000;
const MAX_TOKENS = 600;
const FRAME_LONG_SIDE = 1280;

type ChatContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

interface Frame {
  buffer: Buffer;
  timestamp: string;
  tempPath: string;
}

export async function lookAtImage(deps: LookDeps, args: LookAtImageArgs): Promise<LookResult> {
  try {
    const { buffer: original, mime, ext } = await readValidatedImage(deps, args.path);
    const filter = buildFilter(args.region, args.zoom);
    const buffer = filter ? await cropAndZoom(deps, args.path, ext, filter) : original;
    const content: ChatContent = [
      { type: 'text', text: args.question },
      { type: 'image_url', image_url: { url: toDataUrl(mime, buffer) } },
    ];
    const text = await withTimeout((signal) => postChat(deps, content, signal));
    return { ok: true, text };
  } catch (err) {
    return { ok: false, text: failureMessage(err) };
  }
}

export async function lookAtVideo(deps: LookDeps, args: LookAtVideoArgs): Promise<LookResult> {
  const everySeconds = args.everySeconds ?? 2;
  const maxFrames = args.maxFrames ?? 30;
  let frames: Frame[] = [];
  try {
    frames = await extractFrames(deps, args.path, everySeconds, maxFrames);
    if (frames.length === 0) throw new Error('No frames could be extracted from the video.');
    const notes: string[] = [];
    for (const frame of frames) {
      const content: ChatContent = [
        { type: 'text', text: `At ${frame.timestamp}, relevant to: ${args.question}` },
        { type: 'image_url', image_url: { url: toDataUrl('image/png', frame.buffer) } },
      ];
      const answer = await withTimeout((signal) => postChat(deps, content, signal));
      notes.push(`## ${frame.timestamp}\n${answer}`);
    }
    const summary = `Question: ${args.question}\n\nFrame notes:\n${notes.join('\n\n')}\n\nAnswer the question using only these notes.`;
    const finalAnswer = await withTimeout((signal) => postChat(deps, summary, signal));
    return { ok: true, text: `${notes.join('\n\n')}\n\n## Answer\n${finalAnswer}` };
  } catch (err) {
    return { ok: false, text: failureMessage(err) };
  } finally {
    await Promise.all(frames.map((f) => safeUnlink(f.tempPath)));
  }
}

function failureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toDataUrl(mime: string, buffer: Buffer): string {
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

async function readValidatedImage(deps: LookDeps, filePath: string): Promise<{ buffer: Buffer; mime: string; ext: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const mime = IMAGE_MIME_TYPES[ext];
  if (!mime) throw new Error(`Unsupported image type "${ext || '(none)'}"; use png, jpg, jpeg, webp or gif.`);
  let buffer: Buffer;
  try {
    buffer = await deps.readFile(filePath);
  } catch {
    throw new Error(`Image not found: ${filePath}`);
  }
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too big (${Math.round(buffer.length / 1024 / 1024)} MB); the limit is 20 MB.`);
  }
  return { buffer, mime, ext };
}

/** Builds ffmpeg's -vf filter for a region and/or zoom; undefined when neither is asked for. Nearest-neighbour
 * scaling keeps pixel edges sharp when zooming. The crop clamps to the image's own size at ffmpeg's filter-eval
 * time (iw/ih), since we never probe the image's dimensions ourselves. */
function buildFilter(region?: Region, zoom?: number): string | undefined {
  const parts: string[] = [];
  if (region) {
    const x = Math.max(0, Math.trunc(region.x));
    const y = Math.max(0, Math.trunc(region.y));
    const w = Math.max(1, Math.trunc(region.width));
    const h = Math.max(1, Math.trunc(region.height));
    parts.push(`crop=min(iw-${x}\\,${w}):min(ih-${y}\\,${h}):${x}:${y}`);
  }
  if (zoom && zoom > 1) {
    const z = Math.min(8, Math.max(1, Math.round(zoom)));
    parts.push(`scale=iw*${z}:ih*${z}:flags=neighbor`);
  }
  return parts.length ? parts.join(',') : undefined;
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}

async function cropAndZoom(deps: LookDeps, inputPath: string, ext: string, filter: string): Promise<Buffer> {
  const outPath = path.join(deps.tmpDir, `look-${randomUUID()}${ext}`);
  try {
    await deps.ffmpeg(['-y', '-i', inputPath, '-vf', filter, outPath]);
    return await deps.readFile(outPath);
  } catch (err) {
    if (isEnoent(err)) throw new Error("ffmpeg isn't installed; can't crop or zoom this image.");
    throw err;
  } finally {
    await safeUnlink(outPath);
  }
}

function frameTimestamp(index: number, everySeconds: number): string {
  const totalSeconds = Math.round(index * everySeconds);
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

async function extractFrames(deps: LookDeps, inputPath: string, everySeconds: number, maxFrames: number): Promise<Frame[]> {
  const id = randomUUID();
  const pattern = path.join(deps.tmpDir, `look-frame-${id}-%03d.png`);
  const fps = 1 / everySeconds;
  const scale = `scale='if(gt(iw\\,ih)\\,min(${FRAME_LONG_SIDE}\\,iw)\\,-2)':'if(gt(iw\\,ih)\\,-2\\,min(${FRAME_LONG_SIDE}\\,ih))'`;
  try {
    await deps.ffmpeg(['-y', '-i', inputPath, '-vf', `fps=${fps},${scale}`, '-vframes', String(maxFrames), pattern]);
  } catch (err) {
    if (isEnoent(err)) throw new Error("ffmpeg isn't installed; can't look at videos without it.");
    throw new Error(`Couldn't read the video: ${failureMessage(err)}`);
  }
  const frames: Frame[] = [];
  for (let i = 1; i <= maxFrames; i++) {
    const tempPath = pattern.replace('%03d', String(i).padStart(3, '0'));
    let buffer: Buffer;
    try {
      buffer = await deps.readFile(tempPath);
    } catch {
      break;
    }
    frames.push({ buffer, timestamp: frameTimestamp(i - 1, everySeconds), tempPath });
  }
  return frames;
}

async function safeUnlink(filePath: string): Promise<void> {
  try {
    await rm(filePath, { force: true, maxRetries: 3 });
  } catch {
    // best effort: a fake ffmpeg in tests writes nothing real to remove
  }
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function providerErrorDetail(res: Response): Promise<string> {
  let raw = '';
  try {
    raw = await res.text();
  } catch {
    // body unreadable; fall through to the status line
  }
  try {
    const data = JSON.parse(raw) as { error?: { message?: string } | string; message?: string };
    if (typeof data.error === 'string') return data.error;
    if (data.error?.message) return data.error.message;
    if (data.message) return data.message;
  } catch {
    // not JSON
  }
  return raw.trim().slice(0, 500) || res.statusText || `HTTP ${res.status}`;
}

async function postChat(deps: LookDeps, content: ChatContent, signal: AbortSignal): Promise<string> {
  const { baseURL, model, apiKey } = deps.endpoint;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  let res: Response;
  try {
    res = await deps.fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content }],
        max_tokens: MAX_TOKENS,
        chat_template_kwargs: { enable_thinking: false },
      }),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`timed out after ${TIMEOUT_MS / 1000}s`);
    throw new Error(`Endpoint unreachable: ${failureMessage(err)}`);
  }
  if (!res.ok) throw new Error(`Model error (${res.status}): ${await providerErrorDetail(res)}`);
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('The model returned an empty answer.');
  return text;
}
