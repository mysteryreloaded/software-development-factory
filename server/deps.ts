import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// A checkout's npm dependencies, installed by the office before an agent (or a preview) needs them: package.json and
// package-lock.json are hashed into a marker in node_modules, so an unchanged checkout skips the install.

/** Named for the preview, where it started; desks share it. */
export const INSTALL_MARKER = '.cubefarm-preview-install';
export const INSTALL_TIMEOUT_MS = 15 * 60_000;
/** Desk installs running at once, office-wide; the rest queue. */
export const MAX_DESK_INSTALLS = 2;

/** What a checkout's dependencies look like on disk. */
export interface DepsState {
  /** package.json's text; null when there is none. */
  pkg: string | null;
  /** package-lock.json's text; null when there is none. */
  lock: string | null;
  /** bun.lock's (or bun.lockb's) text; null when the checkout has neither. */
  bun?: string | null;
  /** package.json + the lockfile the checkout's installer reads, hashed. */
  hash: string;
  /** The marker the last install left in node_modules ('' when there is none). */
  marker: string;
  nodeModules: boolean;
}

export const depsHash = (pkg: string, lock: string | null) => crypto.createHash('sha256').update(pkg).update('\0').update(lock ?? '').digest('hex');

/** Which installer a checkout uses: bun when it has a bun lockfile, even with a (stale) package-lock.json beside it. */
export type Installer = 'npm' | 'bun';
export const installerOf = (s: DepsState): Installer => (s.bun != null ? 'bun' : 'npm');

export async function readDeps(dir: string): Promise<DepsState> {
  const read = (file: string) => fs.readFile(path.join(dir, file), 'utf8').catch(() => null);
  // bun.lockb is binary; the lossy utf8 text is only hashed, never shown, and is stable per file content.
  const bun = (await read('bun.lock')) ?? (await read('bun.lockb'));
  const [pkg, lock, marker, nodeModules] = await Promise.all([
    read('package.json'),
    read('package-lock.json'),
    read(path.join('node_modules', INSTALL_MARKER)),
    fs
      .stat(path.join(dir, 'node_modules'))
      .then((s) => s.isDirectory())
      .catch(() => false),
  ]);
  const isBun = bun !== null;
  return { pkg, lock, bun, hash: depsHash(pkg ?? '', isBun ? bun : lock), marker: marker ?? '', nodeModules };
}

/** Whether node_modules was installed from exactly this package.json and lockfile. */
export const depsCurrent = (s: DepsState) => s.nodeModules && s.marker === s.hash;

export const writeMarker = (dir: string, hash: string) => fs.writeFile(path.join(dir, 'node_modules', INSTALL_MARKER), hash).catch(() => undefined);

/**
 * What the office does for a desk: nothing without a package.json; a Bun checkout is always the office's to install
 * (bun install --frozen-lockfile), never the agent's; otherwise npm ci with a lockfile, or left to the agent without
 * one (so the office never creates one that ends up in a PR); skip when node_modules matches.
 */
export function deskDepsPlan(s: DepsState): 'none' | 'agent' | 'skip' | 'install' {
  if (s.pkg === null) return 'none';
  if (s.bun != null) return depsCurrent(s) ? 'skip' : 'install';
  if (s.lock === null) return 'agent';
  return depsCurrent(s) ? 'skip' : 'install';
}

export type DepsOutcome = 'none' | 'agent' | 'skipped' | 'installed' | 'failed';

/** The line for the agent's instructions ('' when the office left the dependencies alone), for the checkout's installer. */
export function depsPromptLine(outcome: DepsOutcome | null | undefined, installer: Installer = 'npm'): string {
  const install = installer === 'bun' ? 'bun install' : 'npm install';
  if (outcome === 'installed' || outcome === 'skipped') return `Dependencies are already installed for this checkout; run ${install} only if you change package.json.`;
  if (outcome === 'failed') return `The office couldn't install this checkout's dependencies: run ${install} yourself first.`;
  return '';
}

/** Where the office finds bun: on PATH, else where its installer puts it, which the office's PATH doesn't carry. */
export async function findBun(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'bun.exe' : 'bun';
  const present = async (p: string) => ((await fs.stat(p).catch(() => null)) != null ? p : null);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const p = await present(path.join(dir, name));
    if (p) return p;
  }
  return present(path.join(os.homedir(), '.bun', 'bin', name));
}

/** bun install --frozen-lockfile in a folder (argument array, since bun's path may carry spaces); rejects on failure, and kills the tree after `timeoutMs`. */
export function bunInstall(dir: string, bun: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Same rule as the agents and previews: no Claude credentials or config, and not the office's own settings.
    if (v !== undefined && !/^(ANTHROPIC_|CLAUDE|SWARM_)/i.test(k)) env[k] = v;
  }
  env.NO_COLOR = '1';
  const child = spawn(bun, ['install', '--frozen-lockfile'], { cwd: dir, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (buf: Buffer) => (tail = (tail + buf.toString()).slice(-4000));
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void killTree(child);
      reject(new Error(`bun install took longer than ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = tail.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' · ');
      reject(new Error(`bun install failed (code ${code})${last ? `: ${last.slice(0, 300)}` : ''}`));
    });
  });
}

/** Run at most `max` tasks at once; the rest wait their turn, in order. */
export function createLimiter(max: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async function limit<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await fn();
    } finally {
      const next = waiting.shift();
      if (next) next(); // the slot passes straight on
      else active--;
    }
  };
}

const deskInstalls = createLimiter(MAX_DESK_INSTALLS);

/** Kill a process and its children. */
export function killTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      tk.once('error', () => resolve());
      tk.once('close', () => resolve());
    });
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // the whole process group (spawned detached)
  } catch {
    child.kill('SIGKILL');
  }
  return Promise.resolve();
}

/**
 * Stop a process and its children gracefully: SIGTERM to the whole process group (spawned detached) so a script's
 * cleanup trap runs, then SIGKILL anything still in the group after `graceMs` — not just the leader, since a
 * child can outlive it and keep holding a port. On Windows a shell tree has no graceful signal, so kill at once
 * as before.
 */
export async function stopTree(child: ChildProcess, graceMs = 30_000): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') return killTree(child);
  const pid = child.pid;
  try {
    process.kill(-pid, 'SIGTERM'); // the whole process group (spawned detached)
  } catch {
    child.kill('SIGTERM');
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    try {
      process.kill(-pid, 0); // throws ESRCH once the whole group is gone
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

/** npm ci in a folder (on Windows through cmd.exe); rejects on failure, and kills the tree after `timeoutMs`. */
export function npmCi(dir: string, timeoutMs = INSTALL_TIMEOUT_MS): Promise<void> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    // Same rule as the agents and previews: no Claude credentials or config, and not the office's own settings.
    if (v !== undefined && !/^(ANTHROPIC_|CLAUDE|SWARM_)/i.test(k)) env[k] = v;
  }
  env.NO_COLOR = '1';
  const win = process.platform === 'win32';
  const child = win
    ? spawn('cmd.exe', ['/d', '/s', '/c', 'npm ci --no-audit --no-fund'], { cwd: dir, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, env, windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let tail = '';
  const keep = (buf: Buffer) => (tail = (tail + buf.toString()).slice(-4000));
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      void killTree(child);
      reject(new Error(`npm ci took longer than ${Math.round(timeoutMs / 60_000)} minutes`));
    }, timeoutMs);
    child.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const last = tail.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(' · ');
      reject(new Error(`npm ci failed (code ${code})${last ? `: ${last.slice(0, 300)}` : ''}`));
    });
  });
}

export interface DepsCallbacks {
  log(lines: string[]): void;
  /** An install is about to start (possibly waiting for a free slot): nothing matched. */
  installing(): void;
}

/**
 * Install a desk's dependencies before its agent starts, at most MAX_DESK_INSTALLS at once office-wide. Never throws:
 * a failure is logged and reported as 'failed', and the agent is told to install them itself.
 */
export async function installDesk(dir: string, cb: DepsCallbacks, install: (dir: string) => Promise<void> = npmCi): Promise<DepsOutcome> {
  const { log } = cb;
  let installer: Installer = 'npm';
  let bunPath: string | null = null;
  try {
    const state = await readDeps(dir);
    installer = installerOf(state);
    const plan = deskDepsPlan(state);
    if (plan === 'none') return 'none';
    if (plan === 'agent') {
      log(['No package-lock.json; leaving the dependencies to the agent.']);
      return 'agent';
    }
    if (plan === 'skip') {
      log(['Dependencies unchanged since the last install; skipping it.']);
      return 'skipped';
    }
    // A Bun checkout never falls back to npm: npm would write a package-lock.json that doesn't belong there.
    bunPath = installer === 'bun' ? await findBun() : null;
    if (installer === 'bun' && bunPath === null) {
      log(['bun is not installed on this machine; leaving the dependencies to the agent.']);
      return 'agent';
    }
    log(['Installing dependencies…']);
    cb.installing();
    await deskInstalls(async () => {
      log([installer === 'bun' ? '$ bun install --frozen-lockfile' : '$ npm ci']);
      // bunPath is non-null whenever the installer is bun: the block above returned early when it wasn't.
      await (installer === 'bun' ? bunInstall(dir, bunPath!) : install(dir));
    });
    await writeMarker(dir, state.hash);
    log(['Dependencies installed.']);
    return 'installed';
  } catch (err) {
    log([`⚠ Could not install the dependencies (${(err as Error).message.split(/\r?\n/)[0].slice(0, 300)}); the agent will run ${installer === 'bun' ? 'bun install' : 'npm install'} itself.`]);
    return 'failed';
  }
}
