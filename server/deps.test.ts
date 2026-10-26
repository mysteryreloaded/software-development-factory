import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bunInstall, createLimiter, depsCurrent, depsHash, depsPromptLine, deskDepsPlan, findBun, installerOf, installDesk, MAX_DESK_INSTALLS, readDeps, stopTree, writeMarker, type DepsState } from './deps.ts';

const PKG = '{"name":"app","dependencies":{"left-pad":"^1.3.0"}}';
const LOCK = '{"lockfileVersion":3}';
const BUN_LOCK = '{"bunVersion":"1.2.0"}';
const state = (s: Partial<DepsState>): DepsState => {
  const pkg = s.pkg === undefined ? PKG : s.pkg;
  const lock = s.lock === undefined ? LOCK : s.lock;
  return { pkg, lock, hash: depsHash(pkg ?? '', lock), marker: '', nodeModules: false, ...s };
};

const ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'cubefarm deps '));
afterAll(() => fs.rm(ROOT, { recursive: true, force: true, maxRetries: 5 }));
let seq = 0;
/** A checkout with the given files; node_modules (with a marker for its current hash) when `installed`. */
async function checkout(files: { pkg?: string | null; lock?: string | null }, installed = false) {
  const dir = path.join(ROOT, `desk ${++seq}`);
  await fs.mkdir(dir, { recursive: true });
  const pkg = files.pkg === undefined ? PKG : files.pkg;
  const lock = files.lock === undefined ? LOCK : files.lock;
  if (pkg !== null) await fs.writeFile(path.join(dir, 'package.json'), pkg);
  if (lock !== null) await fs.writeFile(path.join(dir, 'package-lock.json'), lock);
  if (installed) {
    await fs.mkdir(path.join(dir, 'node_modules'));
    await writeMarker(dir, depsHash(pkg ?? '', lock));
  }
  return dir;
}

const quiet = { log: () => undefined, installing: () => undefined };
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('deskDepsPlan', () => {
  const hash = depsHash(PKG, LOCK);
  it('skips when the hash matches and node_modules exists', () => {
    expect(deskDepsPlan(state({ marker: hash, nodeModules: true }))).toBe('skip');
  });

  it('installs when node_modules is missing', () => {
    expect(deskDepsPlan(state({ marker: hash, nodeModules: false }))).toBe('install');
    expect(deskDepsPlan(state({}))).toBe('install');
  });

  it('installs when the lockfile changed', () => {
    expect(deskDepsPlan(state({ lock: '{"lockfileVersion":3,"packages":{}}', marker: hash, nodeModules: true }))).toBe('install');
  });

  it('leaves a checkout without a lockfile to the agent', () => {
    expect(deskDepsPlan(state({ lock: null, nodeModules: true }))).toBe('agent');
  });

  it('does nothing without a package.json', () => {
    expect(deskDepsPlan(state({ pkg: null, lock: null }))).toBe('none');
    expect(deskDepsPlan(state({ pkg: null }))).toBe('none');
  });
});

describe('readDeps (the preview and desks)', () => {
  it('finds an unchanged checkout current, so the install is skipped', async () => {
    const dir = await checkout({}, true);
    expect(depsCurrent(await readDeps(dir))).toBe(true);
  });

  it('notices a changed lockfile or package.json', async () => {
    const dir = await checkout({}, true);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    expect(depsCurrent(await readDeps(dir))).toBe(false);
    const other = await checkout({}, true);
    await fs.writeFile(path.join(other, 'package.json'), '{"name":"app"}');
    expect(depsCurrent(await readDeps(other))).toBe(false);
  });

  it('notices node_modules is gone', async () => {
    const dir = await checkout({}, true);
    await fs.rm(path.join(dir, 'node_modules'), { recursive: true, force: true });
    const deps = await readDeps(dir);
    expect(deps.nodeModules).toBe(false);
    expect(depsCurrent(deps)).toBe(false);
  });
});

describe('installDesk', () => {
  it('installs, writes the marker, and skips the next time', async () => {
    const dir = await checkout({});
    const runs: string[] = [];
    const lines: string[] = [];
    const install = async (d: string) => {
      runs.push(d);
      await fs.mkdir(path.join(d, 'node_modules'), { recursive: true });
    };
    expect(await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, install)).toBe('installed');
    expect(lines).toContain('Installing dependencies…');
    expect(await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, install)).toBe('skipped');
    expect(runs).toEqual([dir]);
    expect(lines.at(-1)).toMatch(/skipping/);
  });

  it('leaves a checkout without a lockfile, or without package.json, alone', async () => {
    const never = async () => {
      throw new Error('should not install');
    };
    expect(await installDesk(await checkout({ lock: null }), quiet, never)).toBe('agent');
    expect(await installDesk(await checkout({ pkg: null, lock: null }), quiet, never)).toBe('none');
  });

  it('reports a failed or timed-out install without throwing, and the prompt tells the agent to install', async () => {
    const lines: string[] = [];
    const failed = await installDesk(await checkout({}), { log: (l) => lines.push(...l), installing: () => undefined }, async () => {
      throw new Error('npm ci took longer than 15 minutes');
    });
    expect(failed).toBe('failed');
    expect(lines.at(-1)).toMatch(/took longer than 15 minutes/);
    expect(depsPromptLine(failed)).toMatch(/run npm install yourself/);
  });

  it(`runs at most ${MAX_DESK_INSTALLS} installs at once; a third waits for a free slot`, async () => {
    expect(MAX_DESK_INSTALLS).toBe(2);
    const dirs = await Promise.all([checkout({}), checkout({}), checkout({})]);
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const install = (d: string) =>
      new Promise<void>((resolve) => {
        started.push(d);
        release.set(d, resolve);
      });
    const done = dirs.map((d) => installDesk(d, quiet, install));
    await vi.waitFor(() => expect(started).toHaveLength(2));
    await tick();
    expect(started).toHaveLength(2); // the third is queued
    const [first, second] = started;
    release.get(second)!();
    await vi.waitFor(() => expect(started).toHaveLength(3));
    const third = started[2];
    expect([first, second, third].sort()).toEqual([...dirs].sort());
    release.get(first)!();
    release.get(third)!();
    expect(await Promise.all(done)).toEqual(['installed', 'installed', 'installed']);
  });
});

describe('bun checkouts', () => {
  // findBun looks at PATH and the home directory: point both at our own folders, and restore them after each test.
  const savedEnv = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  const bin = path.join(ROOT, 'bun bin');
  const home = path.join(ROOT, 'bun home');
  const bunName = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const writeBun = async (dir: string, code: number, ...lines: string[]) => {
    await fs.mkdir(dir, { recursive: true });
    const p = path.join(dir, bunName);
    // This describe sets PATH to our bin folder only, so the script puts the system directories back.
    await fs.writeFile(p, `#!/bin/sh\nexport PATH="$PATH:/usr/bin:/bin"\n${lines.join('\n')}\nexit ${code}\n`);
    await fs.chmod(p, 0o755).catch(() => undefined);
    return p;
  };
  /** A bun checkout: package.json and bun.lock, plus a (stale) package-lock.json unless `lock` is null. */
  async function bunCheckout(lock: string | null = LOCK) {
    const dir = path.join(ROOT, `bun desk ${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), PKG);
    await fs.writeFile(path.join(dir, 'bun.lock'), BUN_LOCK);
    if (lock !== null) await fs.writeFile(path.join(dir, 'package-lock.json'), lock);
    return dir;
  }
  beforeEach(async () => {
    for (const d of [bin, home]) {
      await fs.rm(d, { recursive: true, force: true });
      await fs.mkdir(d, { recursive: true });
    }
    process.env.PATH = bin;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is bun when there is a bun lockfile, even beside a stale package-lock.json, and npm otherwise', () => {
    expect(installerOf(state({}))).toBe('npm');
    expect(installerOf(state({ bun: BUN_LOCK, lock: null }))).toBe('bun');
    expect(installerOf(state({ bun: BUN_LOCK, lock: LOCK }))).toBe('bun');
  });

  it('installs a bun desk even without a package-lock.json, and skips it once the marker matches', () => {
    const hash = depsHash(PKG, BUN_LOCK);
    expect(deskDepsPlan(state({ bun: BUN_LOCK, lock: null }))).toBe('install');
    expect(deskDepsPlan(state({ bun: BUN_LOCK, hash, marker: hash, nodeModules: true }))).toBe('skip');
  });

  it('hashes the bun lockfile, not the stale package-lock.json, and prefers bun.lock over bun.lockb', async () => {
    const dir = path.join(ROOT, `bun desk ${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'package.json'), PKG);
    await fs.writeFile(path.join(dir, 'package-lock.json'), LOCK);
    await fs.writeFile(path.join(dir, 'bun.lockb'), 'binary-lock');
    expect((await readDeps(dir)).hash).toBe(depsHash(PKG, 'binary-lock'));
    await fs.writeFile(path.join(dir, 'bun.lock'), BUN_LOCK);
    expect((await readDeps(dir)).hash).toBe(depsHash(PKG, BUN_LOCK));
  });

  it('finds bun on PATH, then in the home directory, and gives up when it is nowhere', async () => {
    const onPath = await writeBun(bin, 0);
    expect(await findBun()).toBe(onPath);
    await fs.rm(bin, { recursive: true, force: true });
    await fs.mkdir(bin, { recursive: true });
    const inHome = await writeBun(path.join(home, '.bun', 'bin'), 0);
    expect(await findBun()).toBe(inHome);
    await fs.rm(path.join(home, '.bun'), { recursive: true, force: true });
    expect(await findBun()).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('installs a bun desk with bun install --frozen-lockfile, and skips it the next time', async () => {
    const bun = await writeBun(bin, 0, 'mkdir -p node_modules', 'echo "bun $*" > .bun-invoked');
    expect(await findBun()).toBe(bun);
    const dir = await bunCheckout(LOCK);
    const lines: string[] = [];
    const stub = async () => {
      throw new Error('the npm stub must not run for a bun checkout');
    };
    expect(await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, stub)).toBe('installed');
    expect(lines).toContain('$ bun install --frozen-lockfile');
    expect(await fs.readFile(path.join(dir, '.bun-invoked'), 'utf8')).toBe('bun install --frozen-lockfile\n');
    expect(await fs.readFile(path.join(dir, 'node_modules', '.cubefarm-preview-install'), 'utf8')).toBe(depsHash(PKG, BUN_LOCK));
    expect(await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8')).toBe(LOCK); // never written by the office
    const before = lines.length;
    expect(await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, stub)).toBe('skipped');
    expect(lines.slice(before)).toEqual(['Dependencies unchanged since the last install; skipping it.']);
  });

  it.runIf(process.platform !== 'win32')('leaves a bun desk to the agent when bun is not on the machine, and never runs npm', async () => {
    const dir = await bunCheckout();
    const lines: string[] = [];
    const stub = async () => {
      throw new Error('npm must never run for a bun checkout');
    };
    expect(await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, stub)).toBe('agent');
    expect(lines.at(-1)).toMatch(/bun is not installed/);
  });

  it.runIf(process.platform !== 'win32')('reports a failed bun install, and the prompt tells the agent to run bun itself', async () => {
    await writeBun(bin, 3, 'echo "fatal: could not install" 1>&2');
    const dir = await bunCheckout();
    const lines: string[] = [];
    const failed = await installDesk(dir, { log: (l) => lines.push(...l), installing: () => undefined }, async () => {
      throw new Error('should not install');
    });
    expect(failed).toBe('failed');
    expect(lines.at(-1)).toMatch(/run bun install itself/);
    expect(depsPromptLine(failed, 'bun')).toMatch(/run bun install yourself/);
  });
});

describe('createLimiter', () => {
  it('starts the queued task as soon as one finishes, and frees slots after failures', async () => {
    const limit = createLimiter(2);
    let running = 0;
    let peak = 0;
    const job = (ms: number, fail = false) =>
      limit(async () => {
        peak = Math.max(peak, ++running);
        await new Promise((r) => setTimeout(r, ms));
        running--;
        if (fail) throw new Error('boom');
        return ms;
      });
    const results = await Promise.allSettled([job(30, true), job(10), job(10), job(10)]);
    expect(peak).toBe(2);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await job(1)).toBe(1);
  });
});

describe.runIf(process.platform !== 'win32')('bunInstall', () => {
  /** A fake bun: a shell script that records what it was told to do and what was in its environment. */
  const fakeBun = async (lines: string[]) => {
    const dir = path.join(ROOT, `bun bin ${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    const bun = path.join(dir, 'bun');
    await fs.writeFile(bun, `#!/bin/sh\n${lines.join('\n')}\n`);
    await fs.chmod(bun, 0o755);
    return bun;
  };

  it('runs `bun install --frozen-lockfile` in the folder, with the Claude and office settings stripped from its environment', async () => {
    const bun = await fakeBun([`printf '%s\\n' "args $*" "env [\$ANTHROPIC_API_KEY]/[\$NO_COLOR]" > .bun-ran`]);
    const dir = path.join(ROOT, `bun work ${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    process.env.ANTHROPIC_API_KEY = 'test-secret-key';
    const savedNoColor = process.env.NO_COLOR;
    try {
      await bunInstall(dir, bun, 60_000);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      if (savedNoColor === undefined) delete process.env.NO_COLOR;
      else process.env.NO_COLOR = savedNoColor;
    }
    expect((await fs.readFile(path.join(dir, '.bun-ran'), 'utf8')).trim().split('\n')).toEqual(['args install --frozen-lockfile', 'env []/[1]']);
  });

  it('rejects with the last lines of the output when bun fails', async () => {
    const bun = await fakeBun(['echo "boom, line one" 1>&2', 'echo "fatal: could not install" 1>&2', 'exit 3']);
    const dir = path.join(ROOT, `bun work ${++seq}`);
    await fs.mkdir(dir, { recursive: true });
    const err = await bunInstall(dir, bun, 60_000).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^bun install failed \(code 3\)/);
    expect((err as Error).message).toContain('fatal: could not install');
  });
});

describe('depsPromptLine', () => {
  it('says the dependencies are installed after an install or a skip, and nothing when the office left them alone', () => {
    expect(depsPromptLine('installed')).toBe('Dependencies are already installed for this checkout; run npm install only if you change package.json.');
    expect(depsPromptLine('skipped')).toBe(depsPromptLine('installed'));
    expect(depsPromptLine('agent')).toBe('');
    expect(depsPromptLine('none')).toBe('');
    expect(depsPromptLine(undefined)).toBe('');
  });
});

describe('stopTree', () => {
  const running = new Set<ChildProcess>();
  afterEach(() => {
    // The processes in this describe are the only ones spawned here; kill their process groups if still running.
    for (const c of running) {
      if (c.pid === undefined || c.exitCode !== null || c.signalCode !== null) continue;
      try {
        process.kill(-c.pid, 'SIGKILL');
      } catch {}
    }
    running.clear();
  });
  /** Spawned detached, like a preview (previewRunner.ts). */
  const spawnDetached = (cmd: string) => {
    const c = spawn('sh', ['-c', cmd], { detached: true, stdio: 'ignore' });
    running.add(c);
    return c;
  };
  const start = (ms = 400) => new Promise<void>((r) => setTimeout(r, ms));
  const dead = (c: ChildProcess) => c.exitCode !== null || c.signalCode !== null;

  it.skipIf(process.platform === 'win32')('lets a cleanup trap run: SIGTERM, the trap finishes, well before the grace period', async () => {
    const file = path.join(ROOT, `bye ${++seq}.txt`);
    const c = spawnDetached(`F='${file}'; trap 'echo bye > "$F"; exit 0' TERM; while :; do sleep 0.1; done`);
    await start();
    const t0 = Date.now();
    await stopTree(c);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('bye');
    expect(dead(c)).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('kills after the grace period when the process ignores SIGTERM', async () => {
    const c = spawnDetached(`trap '' TERM; while :; do sleep 0.1; done`);
    await start();
    const t0 = Date.now();
    await stopTree(c, 300);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(280);
    expect(elapsed).toBeLessThan(5_000);
    // The SIGKILL lands a tick after stopTree resolves; wait for the process to actually die.
    await new Promise<void>((r) => (dead(c) ? r() : c.once('exit', () => r())));
    expect(c.signalCode).toBe('SIGKILL');
  });

  it.skipIf(process.platform === 'win32')('resolves at once when the process has already exited', async () => {
    const c = spawnDetached('true');
    await new Promise<void>((r) => c.once('exit', () => r()));
    const t0 = Date.now();
    await stopTree(c);
    expect(Date.now() - t0).toBeLessThan(250);
  });

  it.skipIf(process.platform === 'win32')('kills a straggler child that outlives the leader', async () => {
    const file = path.join(ROOT, `child-pid ${++seq}.txt`);
    const c = spawnDetached(`(trap '' TERM; while :; do sleep 0.1; done) & echo $! > '${file}'; trap 'exit 0' TERM; wait`);
    await start();
    let childPid = -1;
    try {
      await stopTree(c, 300);
      childPid = Number((await fs.readFile(file, 'utf8')).trim());
      const childDead = async () => {
        try {
          process.kill(childPid, 0);
          return false;
        } catch {
          return true;
        }
      };
      const deadline = Date.now() + 2_000;
      let isDead = await childDead();
      while (!isDead && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        isDead = await childDead();
      }
      expect(isDead).toBe(true);
    } finally {
      if (childPid > 0) {
        try {
          process.kill(childPid, 'SIGKILL');
        } catch {}
      }
    }
  });

  it.skipIf(process.platform === 'win32')('gives a child that outlives the leader its own time to clean up', async () => {
    const file = path.join(ROOT, `slow-bye ${++seq}.txt`);
    const c = spawnDetached(`(trap 'sleep 0.5; echo bye > "${file}"; exit 0' TERM; while :; do sleep 0.1; done) & trap 'exit 0' TERM; wait`);
    await start();
    const t0 = Date.now();
    await stopTree(c, 5_000);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect((await fs.readFile(file, 'utf8')).trim()).toBe('bye');
  });
});
