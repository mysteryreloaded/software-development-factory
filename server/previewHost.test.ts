import express from 'express';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { previewHostMiddleware, previewHostUpgrade, type PreviewHostBackend } from './previewHost.ts';

const TEMPLATE = 'http://floor{floor}.cubefarm.test';

describe('floor previews behind a Host template', () => {
  let upstream: http.Server;
  let upstreamPort: number;
  let wss: WebSocketServer;
  let running = true;
  let app: http.Server;
  let appPort: number;
  let backend: PreviewHostBackend;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, { location: `http://127.0.0.1:${upstreamPort}/landed` }).end();
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-seen-host': req.headers.host ?? '',
        'x-seen-forwarded-host': req.headers['x-forwarded-host'] ?? '',
        'x-seen-forwarded-proto': req.headers['x-forwarded-proto'] ?? '',
      }).end(`upstream:${req.url}`);
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upstreamPort = (upstream.address() as AddressInfo).port;

    wss = new WebSocketServer({ server: upstream, path: '/echo' });
    wss.on('connection', (ws) => ws.on('message', (data) => ws.send(data)));

    backend = {
      template: () => TEMPLATE,
      floorExists: (floor) => floor === 1,
      portFor: () => (running ? upstreamPort : null),
    };

    const expressApp = express();
    expressApp.use(previewHostMiddleware(backend));
    expressApp.get('/office-route', (_req, res) => res.send('the office'));
    app = http.createServer(expressApp);
    app.on('upgrade', (req, socket, head) => {
      if (previewHostUpgrade(backend, req, socket as Socket, head)) return;
      socket.destroy();
    });
    await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
    appPort = (app.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((r) => app.close(r));
    await new Promise((r) => wss.close(r));
    await new Promise((r) => upstream.close(r));
  });

  const get = (path: string, host: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port: appPort, path, method: 'GET', headers: { host } }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });

  it("proxies a matching Host to the floor's running preview, with the forwarded headers", async () => {
    const res = await get('/hello', 'floor1.cubefarm.test');
    expect(res.status).toBe(200);
    expect(res.body).toBe('upstream:/hello');
    expect(res.headers['x-seen-host']).toBe(`localhost:${upstreamPort}`);
    expect(res.headers['x-seen-forwarded-host']).toBe('floor1.cubefarm.test');
    expect(res.headers['x-seen-forwarded-proto']).toBe('http');
  });

  it("rewrites a Location pointing at the upstream's loopback port to the floor's public origin", async () => {
    const res = await get('/redirect', 'floor1.cubefarm.test');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('http://floor1.cubefarm.test/landed');
  });

  it("falls through to the office's own route on a non-matching Host", async () => {
    const res = await get('/office-route', 'office.example.com');
    expect(res.status).toBe(200);
    expect(res.body).toBe('the office');
  });

  it("falls through to the office's own route with the template off", async () => {
    backend.template = () => '';
    try {
      const res = await get('/office-route', 'floor1.cubefarm.test');
      expect(res.status).toBe(200);
      expect(res.body).toBe('the office');
    } finally {
      backend.template = () => TEMPLATE;
    }
  });

  it('answers 404 for a floor that does not exist', async () => {
    const res = await get('/hello', 'floor2.cubefarm.test');
    expect(res.status).toBe(404);
  });

  it("answers 503 while the floor's app isn't running", async () => {
    running = false;
    try {
      const res = await get('/hello', 'floor1.cubefarm.test');
      expect(res.status).toBe(503);
      expect(res.body).toContain("isn't running");
    } finally {
      running = true;
    }
  });

  it('tunnels a matching WebSocket upgrade to the echo endpoint', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/echo`, { headers: { host: 'floor1.cubefarm.test' } });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });
    const reply = new Promise<string>((resolve) => ws.once('message', (data) => resolve(data.toString())));
    ws.send('ping');
    await expect(reply).resolves.toBe('ping');
    ws.close();
  });

  it("never reaches the office's own websocket on a non-matching Host", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${appPort}/echo`, { headers: { host: 'office.example.com' } });
    const outcome = await new Promise<string>((resolve) => {
      ws.once('open', () => resolve('open'));
      ws.once('error', () => resolve('error'));
      ws.once('unexpected-response', () => resolve('unexpected-response'));
      ws.once('close', () => resolve('close'));
    });
    expect(outcome).not.toBe('open');
  });
});
