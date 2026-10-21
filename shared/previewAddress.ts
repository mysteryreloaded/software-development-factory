// A floor's app, reached from a phone or any device through a tunnel or Tailscale Serve: the manager points a
// hostname per floor at the office's own port, with {floor} standing in for the floor number in the host or the
// port (never the path, since a preview needs its own origin for root paths like /assets, /api and ws). The office
// routes a matching Host to that floor's running preview (server/previewHost.ts) and never opens or binds anything
// of its own.

const PLACEHOLDER = '{floor}';

/** The authority (host[:port]) of an http(s) address, without requiring it to be a syntactically valid URL yet. */
function authorityOf(address: string): string | null {
  const m = address.match(/^https?:\/\/([^/?#]*)/i);
  return m ? m[1] : null;
}

/** An http(s) address template with {floor} in its host or port, or null if invalid. '' (off) passes through. */
export function previewAddress(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return '';
  if (s.length > 300) return null;
  if (!s.includes(PLACEHOLDER)) return null;
  const authority = authorityOf(s);
  if (!authority || !authority.includes(PLACEHOLDER)) return null; // {floor} must land in the host or the port, not the path
  try {
    const probe = new URL(s.replaceAll(PLACEHOLDER, '1'));
    if (probe.protocol !== 'http:' && probe.protocol !== 'https:') return null;
  } catch {
    return null;
  }
  return s;
}

/** The floor's own origin (scheme://host[:port], no path) under the template. */
export function previewOrigin(template: string, floor: number): string {
  const u = new URL(template.replaceAll(PLACEHOLDER, String(floor)));
  return u.origin;
}

/** The floor a request's Host header belongs to under the template, or null (case-insensitive, port-aware). */
export function floorFromHost(host: string, template: string): number | null {
  if (!template) return null;
  const authority = authorityOf(template);
  const idx = authority?.indexOf(PLACEHOLDER) ?? -1;
  if (!authority || idx === -1) return null;
  const prefix = authority.slice(0, idx).toLowerCase();
  const suffix = authority.slice(idx + PLACEHOLDER.length).toLowerCase();
  const h = host.trim().toLowerCase();
  if (h.length < prefix.length + suffix.length || !h.startsWith(prefix) || !h.endsWith(suffix)) return null;
  const mid = h.slice(prefix.length, h.length - suffix.length);
  return /^[1-9]\d*$/.test(mid) ? Number(mid) : null;
}

/** On a remote page (not localhost/127.0.0.1/[::1]), the preview's address through the floor's own origin; else `url` as is. */
export function previewSrc(url: string, floor: number, template: string, pageHostname: string): string {
  const local = pageHostname === 'localhost' || pageHostname === '127.0.0.1' || pageHostname === '[::1]';
  if (local || !template) return url;
  try {
    const origin = previewOrigin(template, floor);
    const u = new URL(url);
    return `${origin}${u.pathname}${u.search}${u.hash}`;
  } catch {
    return url;
  }
}
