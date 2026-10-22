import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyUpload, pruneUploads, readUpload, saveUpload, UPLOAD_MAX_AGE_MS } from './uploads.ts';

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'uploads-test-'));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// A minimal PNG header, like shared/attachments.test.ts's.
function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.set([0, 0, 0, 13], 8);
  buf.set([0x49, 0x48, 0x44, 0x52], 12);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

describe('saveUpload / readUpload', () => {
  it('saves a valid file under <root>/<16-hex id>/<clean name>, with meta.json', async () => {
    const view = await saveUpload(root, 'photo (1).png', png(800, 600));
    expect(view.id).toMatch(/^[0-9a-f]{16}$/);
    expect(view.name).toBe('photo__1_.png');
    expect(view.kind).toBe('image');
    expect(view.width).toBe(800);
    expect(view.height).toBe(600);

    const found = await readUpload(root, view.id);
    expect(found?.view).toEqual(view);
    const bytes = await fs.readFile(found!.file);
    expect(bytes.subarray(0, 8)).toEqual(png(1, 1).subarray(0, 8));

    const meta = JSON.parse(await fs.readFile(path.join(root, view.id, 'meta.json'), 'utf8'));
    expect(meta.savedAt).toBeTypeOf('number');
  });

  it('rejects a bad file with an HttpError carrying the right status', async () => {
    await expect(saveUpload(root, 'photo.png', Buffer.from('not a png'))).rejects.toMatchObject({ status: 415 });
  });

  it('readUpload returns null for an unknown or malformed id', async () => {
    expect(await readUpload(root, 'deadbeefdeadbeef')).toBeNull();
    expect(await readUpload(root, '../../etc/passwd')).toBeNull();
  });
});

describe('copyUpload', () => {
  it('copies the file into a destination folder as "<id>-<name>"', async () => {
    const view = await saveUpload(root, 'notes.txt', Buffer.from('hello'));
    const destDir = path.join(root, 'dest');
    const copied = await copyUpload(root, view.id, destDir);
    expect(copied?.path).toBe(path.join(destDir, `${view.id}-notes.txt`));
    expect(await fs.readFile(copied!.path, 'utf8')).toBe('hello');
  });

  it('returns null when the id does not exist', async () => {
    expect(await copyUpload(root, 'deadbeefdeadbeef', path.join(root, 'dest'))).toBeNull();
  });
});

describe('pruneUploads', () => {
  it('removes uploads older than 30 days and keeps fresher ones', async () => {
    const old = await saveUpload(root, 'old.txt', Buffer.from('old'));
    const fresh = await saveUpload(root, 'fresh.txt', Buffer.from('fresh'));
    const oldMetaPath = path.join(root, old.id, 'meta.json');
    const meta = JSON.parse(await fs.readFile(oldMetaPath, 'utf8'));
    meta.savedAt = Date.now() - UPLOAD_MAX_AGE_MS - 1000;
    await fs.writeFile(oldMetaPath, JSON.stringify(meta));

    await pruneUploads(root);

    expect(await readUpload(root, old.id)).toBeNull();
    expect(await readUpload(root, fresh.id)).not.toBeNull();
  });
});
