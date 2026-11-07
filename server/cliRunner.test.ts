import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleLook, lostConversation, resumableSession } from './cliRunner.ts';
import type { FfmpegRunner, LookDeps, ReadFile } from './look.ts';

describe('resumableSession', () => {
  const onDisk = (files: string[]) => (file: string) => files.includes(file);
  const hook = { hook_event_name: 'PreToolUse', session_id: 'abc', transcript_path: 'abc.jsonl' };

  it("keeps the session once Claude Code's conversation file exists", () => {
    expect(resumableSession(hook, onDisk(['abc.jsonl']))).toBe('abc');
  });

  it("doesn't keep it while the file isn't written yet (SessionStart, UserPromptSubmit)", () => {
    expect(resumableSession({ ...hook, hook_event_name: 'UserPromptSubmit' }, onDisk([]))).toBeNull();
  });

  it("doesn't keep it from a call with no transcript path (the status line) or no session", () => {
    expect(resumableSession({ hook_event_name: 'StatusLine', session_id: 'abc' }, () => true)).toBeNull();
    expect(resumableSession({ hook_event_name: 'Stop', transcript_path: 'abc.jsonl' }, () => true)).toBeNull();
  });
});

describe('lostConversation', () => {
  it("spots Claude Code's message for a resume with nothing to resume", () => {
    expect(lostConversation('\n No conversation found with session ID: 6cc74c7e-0c81-4bff-a140-cc8307c1d11b\n')).toBe(true);
  });

  it('ignores other screens', () => {
    expect(lostConversation('Claude Code v2.1.280\n❯ ')).toBe(false);
  });
});

describe('the look tool over HTTP (#123)', () => {
  let server: http.Server;
  let base: string;

  const fakeDeps = (): LookDeps => {
    const ffmpeg: FfmpegRunner = async () => ({ stdout: '', stderr: '' });
    const readFile: ReadFile = async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    };
    return { endpoint: { baseURL: 'http://model.test/v1', model: 'm' }, fetch: fetch, ffmpeg, readFile, tmpDir: '/tmp' };
  };

  beforeAll(async () => {
    const app = express();
    app.post('/api/look/:token', express.json({ limit: '4mb' }), (req, res, next) =>
      void handleLook(String(req.params.token), req, res, (t) => (t === 'known' ? fakeDeps() : undefined)).catch(next),
    );
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  const rpc = (token: string, body: unknown) =>
    fetch(`${base}/api/look/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(body),
    });

  it('answers 404 for an unknown token', async () => {
    const res = await rpc('nope', { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/session has ended/);
  });

  it('serves both look tools for a known token', async () => {
    const res = await rpc('known', { jsonrpc: '2.0', method: 'tools/list', id: 1 });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual(['look_at_image', 'look_at_video']);
  });
});
