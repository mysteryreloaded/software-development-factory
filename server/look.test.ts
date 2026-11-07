import { describe, expect, it, vi } from 'vitest';
import { lookAtImage, lookAtVideo, type FfmpegRunner, type LookDeps, type ReadFile } from './look.ts';

const PNG_PATH = '/images/screenshot.png';
const PNG_BUFFER = Buffer.from('fake-png-bytes');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, statusText: status === 200 ? 'OK' : 'Error' });
}

function answerFetch(content: string | null = 'the answer') {
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const fetchFn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? '{}')),
      headers: { ...(init?.headers as Record<string, string>) },
    });
    return jsonResponse({ choices: [{ message: { content } }] });
  });
  return { fetchFn, calls };
}

function baseDeps(over: Partial<LookDeps> = {}): LookDeps {
  const noopFfmpeg: FfmpegRunner = async () => ({ stdout: '', stderr: '' });
  const readFile: ReadFile = async (p) => {
    if (p === PNG_PATH) return PNG_BUFFER;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  return {
    endpoint: { baseURL: 'http://model.test/v1', model: 'qwen3.8-27b' },
    fetch: (answerFetch().fetchFn as unknown) as typeof fetch,
    ffmpeg: noopFfmpeg,
    readFile,
    tmpDir: '/tmp/look-test',
    ...over,
  };
}

describe('lookAtImage', () => {
  it('sends exactly one image_url alongside the question and returns the model text', async () => {
    const { fetchFn, calls } = answerFetch('it is a cat');
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'what is this?' });
    expect(result).toEqual({ ok: true, text: 'it is a cat' });
    expect(calls).toHaveLength(1);
    const content = calls[0].body.messages as Array<{ content: unknown }>;
    const images = (content[0].content as Array<{ type: string }>).filter((c) => c.type === 'image_url');
    expect(images).toHaveLength(1);
    expect(calls[0].body.max_tokens).toBe(600);
    expect(calls[0].body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('sends no Authorization header when no API key is configured', async () => {
    const { fetchFn, calls } = answerFetch();
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch });
    await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(calls[0].headers.Authorization).toBeUndefined();
  });

  it('sends a bearer Authorization header when an API key is configured, and never leaks it', async () => {
    const { fetchFn, calls } = answerFetch();
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch, endpoint: { baseURL: 'http://model.test/v1', model: 'm', apiKey: 'sk-secret' } });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(calls[0].headers.Authorization).toBe('Bearer sk-secret');
    expect(result.text).not.toContain('sk-secret');
  });

  it('crops and zooms with ffmpeg, clamping negative offsets and the zoom range', async () => {
    const ffmpegArgs: string[][] = [];
    const ffmpeg: FfmpegRunner = async (args) => {
      ffmpegArgs.push(args);
      return { stdout: '', stderr: '' };
    };
    const readFile: ReadFile = async (p) => {
      if (p === PNG_PATH) return PNG_BUFFER;
      return Buffer.from('cropped-bytes'); // the ffmpeg output file
    };
    const { fetchFn, calls } = answerFetch();
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch, ffmpeg, readFile });
    const result = await lookAtImage(deps, {
      path: PNG_PATH,
      question: 'q',
      region: { x: -5, y: 10, width: 100, height: 50 },
      zoom: 12,
    });
    expect(result.ok).toBe(true);
    expect(ffmpegArgs).toHaveLength(1);
    const vf = ffmpegArgs[0][ffmpegArgs[0].indexOf('-vf') + 1];
    expect(vf).toBe('crop=min(iw-0\\,100):min(ih-10\\,50):0:10,scale=iw*8:ih*8:flags=neighbor');
    const imageUrl = (calls[0].body.messages as Array<{ content: Array<{ type: string; image_url?: { url: string } }> }>)[0]
      .content.find((c) => c.type === 'image_url')!.image_url!.url;
    expect(Buffer.from(imageUrl.split(',')[1], 'base64').toString()).toBe('cropped-bytes');
  });

  it('skips ffmpeg entirely with no region or zoom', async () => {
    const ffmpeg = vi.fn<FfmpegRunner>(async () => ({ stdout: '', stderr: '' }));
    const deps = baseDeps({ ffmpeg });
    await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(ffmpeg).not.toHaveBeenCalled();
  });

  it('fails softly when the file is missing, instead of throwing', async () => {
    const deps = baseDeps();
    const result = await lookAtImage(deps, { path: '/nowhere.png', question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/not found/i);
  });

  it('fails softly when the image is too big', async () => {
    const readFile: ReadFile = async () => Buffer.alloc(21 * 1024 * 1024);
    const deps = baseDeps({ readFile });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/too big/i);
  });

  it('fails softly on an unsupported file type', async () => {
    const deps = baseDeps();
    const result = await lookAtImage(deps, { path: '/images/thing.bmp', question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/unsupported/i);
  });

  it('fails softly when ffmpeg is not installed, but a plain look without region/zoom still works', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const ffmpeg: FfmpegRunner = async () => {
      throw enoent;
    };
    const { fetchFn } = answerFetch('fine');
    const deps = baseDeps({ ffmpeg, fetch: fetchFn as unknown as typeof fetch });

    const withZoom = await lookAtImage(deps, { path: PNG_PATH, question: 'q', zoom: 2 });
    expect(withZoom.ok).toBe(false);
    expect(withZoom.text).toMatch(/ffmpeg/i);

    const plain = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(plain).toEqual({ ok: true, text: 'fine' });
  });

  it('fails softly when the endpoint is unreachable', async () => {
    const fetchFn = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/unreachable/i);
  });

  it('fails softly on a non-2xx response, with the status and the provider message, never the key', async () => {
    const fetchFn = vi.fn(async () => jsonResponse({ error: { message: 'bad request: field missing' } }, 400));
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch, endpoint: { baseURL: 'http://model.test/v1', model: 'm', apiKey: 'sk-secret' } });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toContain('400');
    expect(result.text).toContain('bad request: field missing');
    expect(result.text).not.toContain('sk-secret');
  });

  it('fails softly on an empty answer', async () => {
    const { fetchFn } = answerFetch('   ');
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch });
    const result = await lookAtImage(deps, { path: PNG_PATH, question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/empty/i);
  });
});

describe('lookAtVideo', () => {
  const VIDEO_PATH = '/videos/clip.mp4';

  function videoDeps(frameCount: number, answers: string[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchFn = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}'));
      bodies.push(body);
      const content = answers[bodies.length - 1] ?? 'summary';
      return jsonResponse({ choices: [{ message: { content } }] });
    });
    const ffmpeg: FfmpegRunner = async () => ({ stdout: '', stderr: '' });
    const readFile: ReadFile = async (p) => {
      if (p === VIDEO_PATH) throw new Error('not an image');
      const match = /-(\d{3})\.png$/.exec(p);
      if (!match) throw new Error('unexpected path');
      const index = Number(match[1]);
      if (index > frameCount) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return Buffer.from(`frame-${index}`);
    };
    const deps = baseDeps({ fetch: fetchFn as unknown as typeof fetch, ffmpeg, readFile });
    return { deps, bodies };
  }

  it('makes one request per frame plus one text-only request, with the right frame times', async () => {
    const { deps, bodies } = videoDeps(3, ['frame one', 'frame two', 'frame three', 'final answer']);
    const result = await lookAtVideo(deps, { path: VIDEO_PATH, question: 'what happens?', everySeconds: 2, maxFrames: 10 });

    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(4); // 3 frames + 1 summary
    for (const body of bodies) {
      const content = (body.messages as Array<{ content: unknown }>)[0].content;
      const images = Array.isArray(content) ? content.filter((c: { type: string }) => c.type === 'image_url') : [];
      expect(images.length).toBeLessThanOrEqual(1);
    }
    expect(bodies[3].messages).toEqual([{ role: 'user', content: expect.stringContaining('what happens?') }]);
    expect(result.text).toContain('## 0:00\nframe one');
    expect(result.text).toContain('## 0:02\nframe two');
    expect(result.text).toContain('## 0:04\nframe three');
    expect(result.text).toContain('## Answer\nfinal answer');
  });

  it('stops at the first missing frame, never exceeding maxFrames', async () => {
    const { deps, bodies } = videoDeps(30, Array.from({ length: 6 }, (_, i) => `f${i}`));
    const result = await lookAtVideo(deps, { path: VIDEO_PATH, question: 'q', everySeconds: 1, maxFrames: 5 });
    expect(result.ok).toBe(true);
    expect(bodies).toHaveLength(6); // 5 frames + 1 summary
  });

  it('fails softly when ffmpeg is not installed', async () => {
    const enoent = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    const ffmpeg: FfmpegRunner = async () => {
      throw enoent;
    };
    const deps = baseDeps({ ffmpeg });
    const result = await lookAtVideo(deps, { path: VIDEO_PATH, question: 'q' });
    expect(result.ok).toBe(false);
    expect(result.text).toMatch(/ffmpeg/i);
  });
});
