// Files the manager attaches to a phone message (#48): saved under <SWARM_HOME>/uploads/<16-hex id>/<clean name>
// plus a meta.json, served back at GET /api/uploads/:id, and copied into the CEO's folder when a message reaches it
// (server/swarm.ts messageCeo). shared/attachments.ts has the limits and the byte-level checks; this is just the disk
// side of it.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { checkAttachment, cleanName, imageSize, ruleFor } from '../shared/attachments.ts';
import type { AttachmentView } from '../shared/types.ts';
import { HttpError } from './httpError.ts';

const META = 'meta.json';
const ID_RE = /^[0-9a-f]{16}$/;
export const UPLOAD_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

interface Meta extends AttachmentView {
  savedAt: number;
}

const metaOf = (view: AttachmentView, savedAt: number): Meta => ({ ...view, savedAt });
const viewOf = (meta: Meta): AttachmentView => {
  const { savedAt, ...view } = meta;
  void savedAt;
  return view;
};

/** Validates `buf` (shared/attachments.ts checkAttachment) and saves it under `root`; throws HttpError on refusal. */
export async function saveUpload(root: string, name: string, buf: Buffer): Promise<AttachmentView> {
  const problem = checkAttachment({ name, size: buf.length, buf });
  if (problem) throw new HttpError(problem.status, problem.message);
  const rule = ruleFor(name);
  const id = crypto.randomBytes(8).toString('hex');
  const clean = cleanName(name);
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, clean), buf);
  const dims = rule.kind === 'image' ? imageSize(buf) : null;
  const view: AttachmentView = { id, name: clean, mime: rule.mime, kind: rule.kind, size: buf.length, ...(dims ? { width: dims.width, height: dims.height } : {}) };
  await fs.writeFile(path.join(dir, META), JSON.stringify(metaOf(view, Date.now())), 'utf8');
  return view;
}

async function readMeta(root: string, id: string): Promise<Meta | null> {
  if (!ID_RE.test(id)) return null;
  const text = await fs.readFile(path.join(root, id, META), 'utf8').catch(() => null);
  if (!text) return null;
  try {
    return JSON.parse(text) as Meta;
  } catch {
    return null;
  }
}

/** The file's view and where its bytes are on disk, or null when the id doesn't exist. */
export async function readUpload(root: string, id: string): Promise<{ view: AttachmentView; file: string } | null> {
  const meta = await readMeta(root, id);
  if (!meta) return null;
  return { view: viewOf(meta), file: path.join(root, id, meta.name) };
}

/** Copies a saved upload into `destDir` as "<id>-<name>" (CEO_DIR/attachments); null when the id doesn't exist. */
export async function copyUpload(root: string, id: string, destDir: string): Promise<{ view: AttachmentView; path: string } | null> {
  const found = await readUpload(root, id);
  if (!found) return null;
  await fs.mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, `${id}-${found.view.name}`);
  await fs.copyFile(found.file, dest);
  return { view: found.view, path: dest };
}

/** Removes uploads older than 30 days. */
export async function pruneUploads(root: string, now = Date.now()): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const meta = await readMeta(root, e.name);
    if (!meta || now - meta.savedAt > UPLOAD_MAX_AGE_MS) await fs.rm(path.join(root, e.name), { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }
}
