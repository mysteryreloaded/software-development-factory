import type http from 'node:http';
import type net from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { floorFromHost } from '../shared/previewAddress.ts';
import { loopbackPath, passHeaders, tunnel, upstream } from './syncProxy.ts';

// Floor previews on a phone or any device behind a tunnel or Tailscale Serve: with a `previewAddress` template set
// (shared/previewAddress.ts), a request whose Host matches floor N's hostname is proxied straight to floor N's
// running main preview, HTTP and WebSocket upgrades alike, so the preview's own root paths (/assets, /api, ws) and
// its origin reach the device. Mounted first in server/index.ts, ahead of the office's own routes and its own
// upgrade handling, so a non-matching Host (or the template off) is untouched and a preview's traffic never reaches
// the live office.

export interface PreviewHostBackend {
  /** The `previewAddress` setting; '' means off. */
  template(): string;
  /** Whether floor N exists at all. */
  floorExists(floor: number): boolean;
  /** Floor N's main preview port while it's running, else null. */
  portFor(floor: number): number | null;
}

const forwardedProto = (req: http.IncomingMessage) => String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim() || 'http';

/** A Location pointing back at the preview's loopback port goes to the floor's public origin instead. */
function rewriteToOrigin(location: string, port: number, origin: string): string {
  const p = loopbackPath(location, port);
  return p === null ? location : `${origin}${p}`;
}

/** First middleware in server/index.ts: a floor's Host is proxied to its running preview; anything else falls through. */
export function previewHostMiddleware(backend: PreviewHostBackend) {
  return (req: Request, res: Response, next: NextFunction) => {
    const floor = floorFromHost(String(req.headers.host ?? ''), backend.template());
    if (floor == null) return next();
    if (!backend.floorExists(floor)) return void res.status(404).type('text/plain').end(`No floor ${floor}`);
    const port = backend.portFor(floor);
    if (port == null) return void res.status(503).type('text/plain').end(`Floor ${floor}'s app isn't running: start it in the office`);

    const origin = `${forwardedProto(req)}://${req.headers.host}`;
    const body: Buffer[] = [];
    req.on('data', (c: Buffer) => body.push(c));
    req.once('end', () => {
      upstream(
        port,
        req,
        Buffer.concat(body),
        (ur) => {
          const headers = passHeaders(ur.headers);
          if (typeof headers.location === 'string') headers.location = rewriteToOrigin(headers.location, port, origin);
          res.writeHead(ur.statusCode ?? 502, headers);
          ur.pipe(res);
        },
        (err) => {
          if (res.headersSent) return void res.destroy();
          res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }).end(`The app isn't answering on port ${port}: ${err.message}`);
        },
        { 'x-forwarded-host': String(req.headers.host ?? ''), 'x-forwarded-proto': forwardedProto(req) },
      );
    });
  };
}

/** Checked first in server/index.ts's upgrade handler: true when this upgrade was (or will be) handled here. */
export function previewHostUpgrade(backend: PreviewHostBackend, req: http.IncomingMessage, socket: net.Socket, head: Buffer): boolean {
  const floor = floorFromHost(String(req.headers.host ?? ''), backend.template());
  if (floor == null) return false;
  const port = backend.portFor(floor);
  if (port == null) {
    socket.destroy();
    return true;
  }
  tunnel(port, req, socket, head, { 'X-Forwarded-Host': String(req.headers.host ?? ''), 'X-Forwarded-Proto': forwardedProto(req) });
  return true;
}
