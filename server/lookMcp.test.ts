import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createLookServer } from './lookMcp.ts';
import type { FfmpegRunner, LookDeps, ReadFile } from './look.ts';

const PNG_PATH = '/images/screenshot.png';
const PNG_BUFFER = Buffer.from('fake-png-bytes');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function baseDeps(over: Partial<LookDeps> = {}): LookDeps {
  const noopFfmpeg: FfmpegRunner = async () => ({ stdout: '', stderr: '' });
  const readFile: ReadFile = async (p) => {
    if (p === PNG_PATH) return PNG_BUFFER;
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  };
  const fetchFn = (async () => jsonResponse({ choices: [{ message: { content: 'an answer' } }] })) as unknown as typeof fetch;
  return {
    endpoint: { baseURL: 'http://model.test/v1', model: 'qwen3.8-27b' },
    fetch: fetchFn,
    ffmpeg: noopFfmpeg,
    readFile,
    tmpDir: '/tmp/look-mcp-test',
    ...over,
  };
}

async function connect(deps: LookDeps) {
  const server = createLookServer(deps);
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('createLookServer', () => {
  it('lists both tools', async () => {
    const client = await connect(baseDeps());
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['look_at_image', 'look_at_video']);
    for (const t of tools) {
      expect(t.description).toMatch(/Another model looks for you/);
    }
  });

  it('look_at_image returns the model text on success', async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({ name: 'look_at_image', arguments: { path: PNG_PATH, question: 'what is this?' } });
    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: 'text', text: 'an answer' }]);
  });

  it('look_at_image returns isError on failure, instead of throwing', async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({ name: 'look_at_image', arguments: { path: '/nowhere.png', question: 'q' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0].text).toMatch(/not found/i);
  });

  it('look_at_video returns isError on failure', async () => {
    const client = await connect(baseDeps());
    const result = await client.callTool({
      name: 'look_at_video',
      arguments: { path: '/videos/missing.mp4', question: 'q' },
    });
    expect(result.isError).toBe(true);
  });
});
