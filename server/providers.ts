// Custom coding-agent providers (#113): an OpenAI-compatible endpoint, run through the OpenCode CLI (server/clis.ts),
// so an agent on one behaves exactly like an OpenCode agent. This module is the pure validation and id logic, plus
// the real check() call; server/swarm.ts holds the provider list (persisted) and the API key (secrets.ts).
import type { ProviderCheckResult } from '../shared/types.ts';
import { CLIS } from './clis.ts';

/** A provider's id can never be one of the built-in CLIs' ids. */
export const RESERVED_PROVIDER_IDS: readonly string[] = CLIS.map((c) => c.id);

/** A slug of a provider's name: lowercase, hyphenated, falling back to "provider" for a name with nothing to slug. */
export function slugifyProviderId(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'provider';
}

/** `base`, or `base-2`, `base-3`… for the first one that isn't reserved or already taken. */
export function uniqueProviderId(base: string, taken: readonly string[]): string {
  const clash = (id: string) => RESERVED_PROVIDER_IDS.includes(id) || taken.includes(id);
  if (!clash(base)) return base;
  let n = 2;
  while (clash(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** An http(s) URL, trimmed of a trailing slash; null when `v` isn't one. */
export function validBaseUrl(v: unknown): string | null {
  const s = String(v ?? '').trim();
  try {
    const u = new URL(s);
    return /^https?:$/.test(u.protocol) ? s.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function cleanLimit(v: unknown): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

export interface ProviderInput {
  name?: unknown;
  baseURL?: unknown;
  apiKey?: unknown;
  model?: unknown;
  contextLimit?: unknown;
  outputLimit?: unknown;
}

export interface ValidatedCreate {
  name: string;
  baseURL: string;
  apiKey: string;
  model: string;
  contextLimit?: number;
  outputLimit?: number;
}

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** A new provider needs a name, an http(s) base URL, a key and a model. */
export function validateCreate(input: ProviderInput): Validated<ValidatedCreate> {
  const name = String(input.name ?? '').trim().slice(0, 60);
  if (!name) return { ok: false, error: 'Name is required.' };
  const baseURL = validBaseUrl(input.baseURL);
  if (!baseURL) return { ok: false, error: 'Base URL must be a valid http(s) URL.' };
  const apiKey = String(input.apiKey ?? '').trim();
  if (!apiKey) return { ok: false, error: 'An API key is required.' };
  const model = String(input.model ?? '').trim();
  if (!model) return { ok: false, error: 'A model name is required.' };
  return { ok: true, value: { name, baseURL, apiKey, model, contextLimit: cleanLimit(input.contextLimit), outputLimit: cleanLimit(input.outputLimit) } };
}

export interface ValidatedUpdate {
  name?: string;
  baseURL?: string;
  model?: string;
  apiKey?: string; // absent: keep the current key
  contextLimit?: number | null; // null: clear it
  outputLimit?: number | null;
}

/** A PUT's fields: only what's given changes; a missing API key keeps the current one. */
export function validateUpdate(input: ProviderInput): Validated<ValidatedUpdate> {
  const out: ValidatedUpdate = {};
  if (input.name !== undefined) {
    const name = String(input.name ?? '').trim().slice(0, 60);
    if (!name) return { ok: false, error: 'Name is required.' };
    out.name = name;
  }
  if (input.baseURL !== undefined) {
    const baseURL = validBaseUrl(input.baseURL);
    if (!baseURL) return { ok: false, error: 'Base URL must be a valid http(s) URL.' };
    out.baseURL = baseURL;
  }
  if (input.model !== undefined) {
    const model = String(input.model ?? '').trim();
    if (!model) return { ok: false, error: 'A model name is required.' };
    out.model = model;
  }
  if (input.apiKey !== undefined && String(input.apiKey).trim() !== '') out.apiKey = String(input.apiKey).trim();
  if (input.contextLimit !== undefined) out.contextLimit = cleanLimit(input.contextLimit) ?? null;
  if (input.outputLimit !== undefined) out.outputLimit = cleanLimit(input.outputLimit) ?? null;
  return { ok: true, value: out };
}

const CHECK_TIMEOUT_MS = 5000;

/** GET {baseURL}/models with the key, from the server (never the client): is it reachable, and is `model` listed. */
export async function checkProviderReal(baseURL: string, apiKey: string, model: string): Promise<ProviderCheckResult> {
  try {
    const res = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!res.ok) return { reachable: true, status: res.status, modelListed: null, error: `Unexpected response (${res.status})` };
    const body = (await res.json().catch(() => null)) as { data?: { id?: unknown }[] } | null;
    const ids = Array.isArray(body?.data) ? body.data.map((m) => String(m?.id ?? '')) : [];
    return { reachable: true, status: res.status, modelListed: ids.includes(model), error: null };
  } catch (err) {
    return { reachable: false, status: null, modelListed: null, error: (err as Error).message || 'Not reachable' };
  }
}
