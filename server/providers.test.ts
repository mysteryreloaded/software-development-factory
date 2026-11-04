import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkProviderReal, slugifyProviderId, uniqueProviderId, validateCreate, validateUpdate, validBaseUrl } from './providers.ts';

describe('slugifyProviderId / uniqueProviderId', () => {
  it('slugs a name, lowercase and hyphenated', () => {
    expect(slugifyProviderId('Local Qwen 27B')).toBe('local-qwen-27b');
    expect(slugifyProviderId('  ???  ')).toBe('provider');
  });

  it('never collides with a built-in id or one already taken', () => {
    expect(uniqueProviderId('opencode', [])).toBe('opencode-2');
    expect(uniqueProviderId('local-qwen', ['local-qwen'])).toBe('local-qwen-2');
    expect(uniqueProviderId('local-qwen', ['local-qwen', 'local-qwen-2'])).toBe('local-qwen-3');
    expect(uniqueProviderId('local-qwen', [])).toBe('local-qwen');
  });
});

describe('validBaseUrl', () => {
  it('accepts http(s) only, trimmed of a trailing slash', () => {
    expect(validBaseUrl('http://127.0.0.1:4100/v1/')).toBe('http://127.0.0.1:4100/v1');
    expect(validBaseUrl('https://my-host/v1')).toBe('https://my-host/v1');
  });

  it('refuses anything else', () => {
    expect(validBaseUrl('ftp://host/v1')).toBeNull();
    expect(validBaseUrl('not a url')).toBeNull();
    expect(validBaseUrl('')).toBeNull();
  });
});

describe('validateCreate', () => {
  const good = { name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-test', model: 'qwen-27b' };

  it('accepts a full, valid input', () => {
    const r = validateCreate(good);
    expect(r).toEqual({ ok: true, value: { name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-test', model: 'qwen-27b', contextLimit: undefined, outputLimit: undefined } });
  });

  it('keeps positive whole-number limits, drops anything else', () => {
    const r = validateCreate({ ...good, contextLimit: 110072.6, outputLimit: -5 });
    expect(r.ok && r.value.contextLimit).toBe(110073);
    expect(r.ok && r.value.outputLimit).toBeUndefined();
  });

  it('needs a name, a valid base URL, a key and a model', () => {
    expect(validateCreate({ ...good, name: '' }).ok).toBe(false);
    expect(validateCreate({ ...good, baseURL: 'not a url' }).ok).toBe(false);
    expect(validateCreate({ ...good, apiKey: '' }).ok).toBe(false);
    expect(validateCreate({ ...good, model: '' }).ok).toBe(false);
  });
});

describe('validateUpdate', () => {
  it('changes only the fields given; a missing key keeps the current one', () => {
    const r = validateUpdate({ name: 'Renamed' });
    expect(r).toEqual({ ok: true, value: { name: 'Renamed' } });
  });

  it('a blank API key is ignored, not cleared', () => {
    const r = validateUpdate({ apiKey: '  ' });
    expect(r.ok && r.value.apiKey).toBeUndefined();
  });

  it('a limit of 0 or blank clears it (null)', () => {
    const r = validateUpdate({ contextLimit: 0, outputLimit: '' });
    expect(r).toEqual({ ok: true, value: { contextLimit: null, outputLimit: null } });
  });

  it('refuses an empty name, URL or model when one is given', () => {
    expect(validateUpdate({ name: '' }).ok).toBe(false);
    expect(validateUpdate({ baseURL: 'nope' }).ok).toBe(false);
    expect(validateUpdate({ model: '' }).ok).toBe(false);
  });
});

/** A tiny OpenAI-compatible /models endpoint, in this process, for checkProviderReal's real HTTP call. */
function fakeOpenAiServer(models: string[], opts: { key?: string } = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/models') return res.writeHead(404).end();
    const auth = req.headers.authorization ?? '';
    if (opts.key && auth !== `Bearer ${opts.key}`) return res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid key' }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: models.map((id) => ({ id })) }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('checkProviderReal: a real GET against a fake OpenAI-compatible server', () => {
  it('reports the model listed', async () => {
    const { url, close } = await fakeOpenAiServer(['qwen-27b', 'qwen-7b'], { key: 'sk-good' });
    try {
      expect(await checkProviderReal(url, 'sk-good', 'qwen-27b')).toEqual({ reachable: true, status: 200, modelListed: true, error: null });
    } finally {
      await close();
    }
  });

  it('reports the model missing', async () => {
    const { url, close } = await fakeOpenAiServer(['qwen-7b'], { key: 'sk-good' });
    try {
      const r = await checkProviderReal(url, 'sk-good', 'qwen-27b');
      expect(r.reachable).toBe(true);
      expect(r.modelListed).toBe(false);
    } finally {
      await close();
    }
  });

  it('reports a wrong key as a 401, model unknown', async () => {
    const { url, close } = await fakeOpenAiServer(['qwen-27b'], { key: 'sk-good' });
    try {
      const r = await checkProviderReal(url, 'sk-wrong', 'qwen-27b');
      expect(r.reachable).toBe(true);
      expect(r.status).toBe(401);
      expect(r.modelListed).toBeNull();
    } finally {
      await close();
    }
  });

  it('reports an unreachable endpoint', async () => {
    const r = await checkProviderReal('http://127.0.0.1:1/v1', 'sk-good', 'qwen-27b');
    expect(r.reachable).toBe(false);
    expect(r.modelListed).toBeNull();
  });
});
