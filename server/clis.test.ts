import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CLIS, clampSessionLimits, cliLabel, cliRuns, CODEX_HOOK_EVENTS, codexHookCommand, commandFor, CROSS_TURN_TOOLS, customProviderOpencodeConfig, hookReviewKey, interruptions, isKnownCli, launchArgs, migrateSessionLimits, oneAtATime, OPENCODE_PLUGIN_FILES, resumeChoice, trustKey, unwrapCmdShim, type LaunchContext } from './clis.ts';
import { describeOfficeTool, describeTool, newScreenshots, screenshotFile, summariseResult } from './agentRunner.ts';

const dir = path.join(os.tmpdir(), 'npm-global');

describe('unwrapCmdShim', () => {
  it('runs node on the script a node shim points at, keeping its node flags', () => {
    const shim = [
      '@ECHO off',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ')',
      'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%" --no-warnings=DEP0040 "%dp0%\\node_modules\\@acme\\cli\\bin\\cli.js" %*',
    ].join('\r\n');
    expect(unwrapCmdShim(path.join(dir, 'cli.cmd'), shim)).toEqual({ file: process.execPath, args: ['--no-warnings=DEP0040', path.join(dir, 'node_modules\\@acme\\cli\\bin\\cli.js')] });
  });

  it('runs the executable an exe shim points at', () => {
    const shim = '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\opencode-ai\\bin\\opencode.exe"   %*\r\n';
    expect(unwrapCmdShim(path.join(dir, 'opencode.cmd'), shim)).toEqual({ file: path.join(dir, 'node_modules\\opencode-ai\\bin\\opencode.exe'), args: [] });
  });

  it('gives up on shims it does not recognise', () => {
    expect(unwrapCmdShim(path.join(dir, 'x.cmd'), '@echo off\r\necho hi\r\n')).toBeNull();
  });
});

describe('migrateSessionLimits (#112)', () => {
  it('applies an old office-wide limit to every coding agent', () => {
    expect(migrateSessionLimits(3)).toEqual(Object.fromEntries(CLIS.map((c) => [c.id, 3])));
  });

  it('becomes no limits for 0 or no old value', () => {
    expect(migrateSessionLimits(0)).toEqual({});
    expect(migrateSessionLimits(undefined)).toEqual({});
  });
});

describe('clampSessionLimits', () => {
  it('keeps only known CLI keys, clamped to whole numbers', () => {
    expect(clampSessionLimits({ claude: 3.6, opencode: -1, bogus: 5 })).toEqual({ claude: 4 });
  });

  it('drops a zero or non-numeric entry (no limit)', () => {
    expect(clampSessionLimits({ claude: 0, codex: 'nope' })).toEqual({});
  });
});

describe('trustKey', () => {
  it("moves Claude Code's trust question off its default \"No, exit\", then confirms \"Yes\"", () => {
    const question = (selected: 'no' | 'yes') =>
      [
        'Accessing workspace:',
        'C:\\Users\\me\\.cubefarm\\workspaces\\me__app\\desks\\ada-01df',
        'Quick safety check: Is this a project you created or one you trust?',
        "Claude Code'll be able to read, edit, and execute files here.",
        selected === 'no' ? '❯ No, exit' : '  No, exit',
        selected === 'yes' ? '❯ Yes, I trust this folder' : '  Yes, I trust this folder',
        'Enter to confirm · Esc to cancel',
      ].join('\n');
    expect(trustKey(question('no'))).toBe('down');
    expect(trustKey(question('yes'))).toBe('enter');
  });

  it("confirms Codex's trust question, whose first option is yes", () => {
    const screen = ['> You are in C:\\desk', '  Do you trust the contents of this directory?', '› 1. Yes, continue', '  2. No, quit'].join('\n');
    expect(trustKey(screen)).toBe('enter');
  });

  it('leaves every other screen alone', () => {
    expect(trustKey('❯ Try "refactor <filepath>"')).toBeNull();
  });
});

describe('hookReviewKey', () => {
  const review = (selected: 1 | 3) =>
    ['  Hooks need review', '  5 hooks are new or changed.', `${selected === 1 ? '›' : ' '} 1. Review hooks`, '  2. Trust all and continue', `${selected === 3 ? '›' : ' '} 3. Continue without trusting (hooks won't run)`].join('\n');

  it("goes on without the office's hooks, leaving trust to the manager", () => {
    expect(hookReviewKey(review(1))).toBe('down');
    expect(hookReviewKey(review(3))).toBe('enter');
    expect(hookReviewKey('› Ask Codex to do anything')).toBeNull();
  });
});

describe('interruptions', () => {
  it('counts the lines where a CLI says it interrupted a turn', () => {
    expect(interruptions(['● Bash(sleep 4)', '  ⎿  Interrupted · What should Claude do instead?', '❯ '].join('\n'))).toBe(1);
    expect(interruptions('■ Conversation interrupted - tell the model what to do differently.\n› ')).toBe(1);
    expect(interruptions('● done\n❯ ')).toBe(0);
  });
});

describe('custom providers (#113): one mapping, no copy', () => {
  const provider = { id: 'local-qwen', name: 'Local Qwen', baseURL: 'http://127.0.0.1:4100/v1', apiKey: 'sk-test', model: 'qwen-27b', contextLimit: 110072, outputLimit: 16384 };

  it('cliRuns maps built-ins to themselves and any other id to opencode', () => {
    expect(cliRuns('claude')).toBe('claude');
    expect(cliRuns('codex')).toBe('codex');
    expect(cliRuns('opencode')).toBe('opencode');
    expect(cliRuns('local-qwen')).toBe('opencode');
  });

  it('isKnownCli accepts built-ins and a listed custom provider, not an unlisted id', () => {
    expect(isKnownCli('claude', [])).toBe(true);
    expect(isKnownCli('local-qwen', [])).toBe(false);
    expect(isKnownCli('local-qwen', [provider])).toBe(true);
  });

  it('cliLabel falls back to a custom provider\'s name', () => {
    expect(cliLabel('local-qwen', [provider])).toBe('Local Qwen');
    expect(cliLabel('local-qwen', [])).toBe('local-qwen');
  });

  it('commandFor a custom provider id resolves OpenCode\'s own command', () => {
    expect(commandFor('local-qwen')).toEqual(commandFor('opencode'));
  });

  it("launchArgs for a custom provider equals OpenCode's except for the provider and model config (#120: opencode has no --model flag)", () => {
    const base: LaunchContext = {
      prompt: 'build it',
      systemAppend: 'You are Ada.',
      model: '',
      effort: 'medium',
      sessionId: '11111111-1111-1111-1111-111111111111',
      name: 'Ada · #1',
      role: 'agent',
      additionalDirectories: [],
      files: { settings: 'settings.json', mcp: null, system: 'instructions.md' },
      notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' },
      codexHook: 'codex-hook.cjs',
      plugin: 'file:///plugin.mjs',
      browser: null,
    };
    const opencode = launchArgs('opencode', base);
    const custom = launchArgs('local-qwen', { ...base, model: `${provider.id}/${provider.model}`, provider });
    // Same args either way: the model goes in the config, never on the command line.
    expect(opencode.args).toEqual(['--auto', '--standalone', '--prompt', 'build it']);
    expect(custom.args).toEqual(['--auto', '--standalone', '--prompt', 'build it']);
    const customConfig = JSON.parse(custom.env.OPENCODE_CONFIG_CONTENT);
    const opencodeConfig = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
    expect(opencodeConfig.model).toBeUndefined();
    expect(customConfig.model).toBe(`${provider.id}/${provider.model}`);
    const { providers, model, ...customRest } = customConfig;
    // Same config, plus the one provider block and the model key.
    expect(providers).toEqual({ [provider.id]: customProviderOpencodeConfig(provider) });
    expect(customRest).toEqual(opencodeConfig);
  });

  it('customProviderOpencodeConfig only includes a limit when set', () => {
    const { id, name, baseURL, apiKey, model } = provider;
    const noLimits = customProviderOpencodeConfig({ id, name, baseURL, apiKey, model });
    expect(noLimits.models[model].limit).toBeUndefined();
    const withLimits = customProviderOpencodeConfig(provider);
    expect(withLimits.models[model].limit).toEqual({ context: provider.contextLimit, output: provider.outputLimit });
  });
});

describe('launchArgs', () => {
  const ctx = (patch: Partial<LaunchContext> = {}): LaunchContext => ({
    prompt: '--looks like a flag',
    systemAppend: 'You are Ada.',
    model: '',
    effort: 'medium',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'Ada · #1',
    role: 'agent',
    additionalDirectories: [],
    files: { settings: 'settings.json', mcp: null, system: 'instructions.md' },
    notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' },
    codexHook: 'codex-hook.cjs',
    plugin: 'file:///plugin.mjs',
    browser: null,
    ...patch,
  });
  it('starts Claude Code on a chosen session id, with the prompt after --', () => {
    const { args } = launchArgs('claude', ctx());
    expect(args.slice(0, 2)).toEqual(['--session-id', '11111111-1111-1111-1111-111111111111']);
    expect(args.slice(-2)).toEqual(['--', '--looks like a flag']);
    // the manager's own setup loads: no limiting its setting sources or MCP servers
    expect(args).not.toContain('--setting-sources');
    expect(args).not.toContain('--strict-mcp-config');
    expect(args).not.toContain('--mcp-config');
  });

  it("resumes Claude Code sessions and keeps the CEO's hands off the shell", () => {
    const { args } = launchArgs('claude', ctx({ resumeId: 'abc', role: 'ceo', files: { settings: 's', mcp: 'mcp.json', system: 'i' } }));
    expect(args.slice(0, 2)).toEqual(['--resume', 'abc']);
    expect(args).toContain('--mcp-config');
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS, 'Bash', 'PowerShell', 'NotebookEdit']);
  });

  it('keeps tools that wait across turns away from Claude Code, but not background shells', () => {
    const { args } = launchArgs('claude', ctx());
    expect(CROSS_TURN_TOOLS).toEqual(['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger']);
    expect(args.slice(args.indexOf('--disallowedTools'), args.indexOf('--'))).toEqual(['--disallowedTools', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode', ...CROSS_TURN_TOOLS]);
    for (const cli of ['codex', 'opencode'] as const) expect(launchArgs(cli, ctx()).args.some((a) => a.includes('Monitor') || a.includes('ScheduleWakeup'))).toBe(false);
  });

  it("runs Codex without its sandbox or approvals, and resumes Codex's thread", () => {
    const fresh = launchArgs('codex', ctx()).args;
    expect(fresh).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(fresh).not.toContain('--sandbox');
    expect(fresh.slice(-2)).toEqual(['--', '--looks like a flag']);
    const resumed = launchArgs('codex', ctx({ resumeId: 'thread-1' })).args;
    expect(resumed[0]).toBe('resume');
    expect(resumed.slice(-2)).toEqual(['thread-1', '--looks like a flag']);
    expect(resumed).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it("gives Codex the office's hooks, with the office's address in its environment", () => {
    const { args, env } = launchArgs('codex', ctx());
    const hooks = args.filter((a) => a.startsWith('hooks.'));
    expect(hooks.map((h) => h.slice(6, h.indexOf('=')))).toEqual(CODEX_HOOK_EVENTS);
    expect(hooks[0]).toContain('type="command"');
    expect(env.CUBEFARM_HOOK_URL).toBe('http://127.0.0.1:1/api/hooks/t');
  });

  it('runs the hook program with a command that never starts with a quote on Windows', () => {
    expect(codexHookCommand('C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs', true)).toBe('node "C:\\Users\\A B\\.cubefarm\\bin\\codex-hook.cjs"');
    expect(codexHookCommand('/usr/bin/node', "/home/o'neil/.cubefarm/bin/codex-hook.cjs", false)).toBe(`'/usr/bin/node' '/home/o'"'"'neil/.cubefarm/bin/codex-hook.cjs'`);
  });

  it("lets OpenCode run on its own private server, without stopping to ask, and without updating itself", () => {
    const config = (patch: Partial<LaunchContext>) => JSON.parse(launchArgs('opencode', ctx(patch)).env.OPENCODE_CONFIG_CONTENT);
    for (const role of ['agent'] as const) expect(config({ role }).permission).toEqual({ edit: 'allow', bash: 'allow', webfetch: 'allow' });
    expect(config({}).autoupdate).toBe(false);
    for (const patch of [{}, { resumeId: 's1' }] as const) {
      const args = launchArgs('opencode', ctx(patch)).args;
      expect(args).toContain('--standalone');
      expect(args).not.toContain('--server');
      expect(args.slice(args.indexOf('--prompt'))).toEqual(['--prompt', '--looks like a flag']);
    }
  });

  it('gives a built-in OpenCode agent with a model its own model key, never a --model flag (#120)', () => {
    const noModel = launchArgs('opencode', ctx());
    expect(noModel.args).toEqual(['--auto', '--standalone', '--prompt', '--looks like a flag']); // byte-for-byte unchanged
    expect(JSON.parse(noModel.env.OPENCODE_CONFIG_CONTENT).model).toBeUndefined();
    const withModel = launchArgs('opencode', ctx({ model: 'anthropic/claude-sonnet-5' }));
    expect(withModel.args).not.toContain('--model');
    expect(withModel.args).toEqual(['--auto', '--standalone', '--prompt', '--looks like a flag']);
    expect(JSON.parse(withModel.env.OPENCODE_CONFIG_CONTENT).model).toBe('anthropic/claude-sonnet-5');
  });
});

describe('resumeChoice', () => {
  const base = { agentCli: 'opencode' as const, inTerminal: true, live: false };

  it('starts on the agent\'s own CLI when there is no session to resume', () => {
    expect(resumeChoice(base)).toEqual({ cli: 'opencode', dropped: false });
  });

  it('drops a session made by another CLI when the start is not a live follow-up', () => {
    expect(resumeChoice({ ...base, resumeId: 's1', resumeCli: 'claude' })).toEqual({ cli: 'opencode', dropped: true });
  });

  it('resumes a session made by the agent\'s own CLI', () => {
    expect(resumeChoice({ ...base, resumeId: 's1', resumeCli: 'opencode' })).toEqual({ cli: 'opencode', resumeId: 's1', dropped: false });
  });

  it('drops a session whose CLI is unknown (a record from before CLIs were named)', () => {
    expect(resumeChoice({ ...base, resumeId: 's1', resumeCli: null })).toEqual({ cli: 'opencode', dropped: true });
  });

  it('a live follow-up stays with the CLI that made the session, or with the agent when it is unknown', () => {
    expect(resumeChoice({ ...base, resumeId: 's1', resumeCli: 'claude', live: true })).toEqual({ cli: 'claude', resumeId: 's1', dropped: false });
    expect(resumeChoice({ ...base, resumeId: 's1', resumeCli: null, live: true })).toEqual({ cli: 'opencode', resumeId: 's1', dropped: false });
  });

  it('the SDK runtime only runs Claude Code, so it resumes only Claude Code sessions', () => {
    expect(resumeChoice({ ...base, inTerminal: false, resumeId: 's1', resumeCli: 'opencode' })).toEqual({ cli: 'opencode', dropped: true });
    expect(resumeChoice({ ...base, inTerminal: false, resumeId: 's1', resumeCli: 'codex' })).toEqual({ cli: 'opencode', dropped: true });
    expect(resumeChoice({ ...base, inTerminal: false, resumeId: 's1', resumeCli: 'claude' })).toEqual({ cli: 'opencode', resumeId: 's1', dropped: false });
    expect(resumeChoice({ ...base, inTerminal: false, resumeId: 's1', resumeCli: null })).toEqual({ cli: 'opencode', resumeId: 's1', dropped: false });
  });
});

describe('the OpenCode 2 plugin', () => {
  // The events and messages exactly as OpenCode 2 delivers them: the event is an { type, data } envelope; messages
  // are flat — type is the role, the text is in content, and the turn ends with a synthetic { type: 'idle' } marker.
  const events = [
    { type: 'session.created', data: { sessionID: 'ses_1' } },
    { type: 'session.idle', data: { sessionID: 'ses_1' } },
    { type: 'session.execution.succeeded', data: { sessionID: 'ses_1' } }, // the same turn reported again: deduped
    { type: 'session.error', data: { sessionID: 'ses_1', error: { message: 'boom' } } },
  ];
  const messages = [
    { type: 'user', text: 'say hi', files: [] },
    { type: 'assistant', content: [{ type: 'reasoning', text: 'hmm' }, { type: 'text', text: 'Hi there' }] },
    { type: 'idle', outcome: 'succeeded' },
  ];

  /** Runs the written plugin's setup against a fake ctx with the given events and messages, counting the POSTs. */
  async function run(url: string | undefined, evs: Record<string, unknown>[], msgs: unknown[]): Promise<Record<string, unknown>[]> {
    const posts: Record<string, unknown>[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      posts.push(JSON.parse(String(init?.body)));
      return { ok: true, json: async () => ({}) };
    }) as typeof fetch;
    const prev = process.env.CUBEFARM_NOTIFY_URL;
    if (url === undefined) delete process.env.CUBEFARM_NOTIFY_URL;
    else process.env.CUBEFARM_NOTIFY_URL = url;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-opencode-plugin-'));
    let resolveDone!: () => void;
    const done = new Promise<void>((r) => (resolveDone = r));
    let subscribed = false;
    const ctx = {
      signal: new AbortController().signal,
      event: { subscribe: () => { subscribed = true; return { [Symbol.asyncIterator]: async function* () { yield* evs; resolveDone(); } }; } },
      session: { context: async () => msgs },
    };
    try {
      for (const [name, content] of Object.entries(OPENCODE_PLUGIN_FILES)) fs.writeFileSync(path.join(dir, name), content);
      const mod = await import(pathToFileURL(path.join(dir, 'index.js')).href) as { default: { setup: (c: unknown) => unknown } };
      await mod.default.setup(ctx);
      // setup returns at once; the event loop it started in the background runs to the end of the fake stream
      if (subscribed) await done;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      if (prev === undefined) delete process.env.CUBEFARM_NOTIFY_URL;
      else process.env.CUBEFARM_NOTIFY_URL = prev;
      globalThis.fetch = realFetch;
    }
    return posts;
  }

  it('posts a TurnComplete with the last assistant message, a TurnError for session.error, and nothing without a URL', async () => {
    expect(await run('http://127.0.0.1:1/api/hooks/t', events, messages)).toEqual([
      { hook_event_name: 'TurnComplete', session_id: 'ses_1', last_assistant_message: 'Hi there' },
      { hook_event_name: 'TurnError', session_id: 'ses_1', error: 'boom' },
    ]);
    expect(await run(undefined, events, messages)).toEqual([]);
  });

  it('treats the first session seen on any event as the root and posts its turn end', async () => {
    const evs = [
      { type: 'session.execution.started', data: { sessionID: 'ses_a' } },
      { type: 'session.idle', data: { sessionID: 'ses_a' } },
    ];
    expect(await run('http://127.0.0.1:1/api/hooks/t', evs, messages)).toEqual([{ hook_event_name: 'TurnComplete', session_id: 'ses_a', last_assistant_message: 'Hi there' }]);
  });

  it('does not post when a child session goes idle after the root is known', async () => {
    const evs = [
      { type: 'session.execution.started', data: { sessionID: 'ses_root' } },
      { type: 'session.idle', data: { sessionID: 'ses_child' } },
    ];
    expect(await run('http://127.0.0.1:1/api/hooks/t', evs, messages)).toEqual([]);
  });
});

describe('oneAtATime', () => {
  it("runs a thread's archive and unarchive in order, other threads alongside, past a step that fails", async () => {
    const steps = oneAtATime();
    const done: string[] = [];
    let release!: () => void;
    const exited = new Promise<void>((r) => (release = r));
    const archive = steps('a', async () => {
      await exited;
      done.push('archive a');
      throw new Error('already archived');
    });
    const unarchive = steps('a', async () => void done.push('unarchive a'));
    await steps('b', async () => void done.push('archive b'));
    expect(done).toEqual(['archive b']);
    release();
    await expect(archive).resolves.toBeUndefined();
    await unarchive;
    expect(done).toEqual(['archive b', 'archive a', 'unarchive a']);
  });
});

describe('screenshotFile', () => {
  it("reads a Playwright screenshot that was saved to a file instead of returned inline", () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-shot-'));
    fs.mkdirSync(path.join(cwd, '.playwright-mcp'));
    fs.writeFileSync(path.join(cwd, '.playwright-mcp', 'pr16-375.png'), 'png-bytes');
    const shot = screenshotFile(cwd, '### Result\n- [Screenshot of viewport](.playwright-mcp/pr16-375.png)');
    expect(shot?.mime).toBe('image/png');
    expect(shot?.data.toString()).toBe('png-bytes');
    expect(screenshotFile(cwd, '### Result\n- no link here')).toBeNull();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
});

describe("Codex's file edits in the log", () => {
  it('names the files an apply_patch touches, and says when it worked', () => {
    const patch = '*** Begin Patch\n*** Add File: notes.txt\n+hi\n*** Update File: src/app.ts\n@@\n-a\n+b\n*** End Patch';
    expect(describeTool(dir, 'apply_patch', { command: patch })).toBe('Edit add notes.txt, src/app.ts');
    expect(summariseResult(dir, 'apply_patch', 'Exit code: 0\nOutput:\nSuccess. Updated the following files:\nA notes.txt')).toEqual([{ kind: 'result', text: '  ⎿ Updated' }]);
    expect(summariseResult(dir, 'apply_patch', 'error: patch did not apply')[0].text).toContain('patch did not apply');
  });
});

describe("the CEO's office tools in the log", () => {
  it('says what each one asks for', () => {
    expect(describeOfficeTool('scale_team', { floor: 2, size: 5, reason: 'Six issues ready, two agents free' })).toBe('📈 scale_team floor 2 → 5: Six issues ready, two agents free');
    expect(describeOfficeTool('configure_agent', { agent_id: 'ada', cli: 'codex', model: '' })).toBe('⚙️ configure_agent ada: codex');
    expect(describeOfficeTool('set_dependencies', { floor: 1, number: 7, depends_on: [3, 4] })).toBe('🔗 set_dependencies #7 → floor 1 · depends on #3, #4');
    expect(describeOfficeTool('set_dependencies', { floor: 1, number: 7, depends_on: [] })).toBe('🔗 set_dependencies #7 → floor 1 · depends on nothing');
    expect(describeOfficeTool('file_issue', { floor: 1, title: 'Dark mode', body: 'x' })).toBe('📝 file_issue "Dark mode" → floor 1');
  });
});

describe('opencode launch args against the real installed CLI (#120, skipped when opencode is not on PATH)', () => {
  const cmd = commandFor('opencode');
  const provider = { id: 'local-qwen', name: 'Local Qwen', baseURL: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'qwen-27b' };
  const base: LaunchContext = {
    prompt: 'hi',
    systemAppend: 'You are Ada.',
    model: '',
    effort: 'medium',
    sessionId: '11111111-1111-1111-1111-111111111111',
    name: 'Ada · #1',
    role: 'agent',
    additionalDirectories: [],
    files: { settings: 'settings.json', mcp: null, system: 'instructions.md' },
    notify: { script: 'notify.cjs', url: 'http://127.0.0.1:1/api/hooks/t' },
    codexHook: 'codex-hook.cjs',
    plugin: 'file:///plugin.mjs',
    browser: null,
  };

  /** Spawns the real CLI with these args/env; waits up to `ms` for it to quit on its own, then kills it. */
  function tryLaunch(launch: { args: string[]; env: Record<string, string> }, ms = 4000): Promise<{ exited: boolean; output: string }> {
    return new Promise((resolve) => {
      const child = spawn(cmd!.file, [...cmd!.args, ...launch.args], { env: { ...process.env, ...launch.env } });
      let output = '';
      child.stdout.on('data', (d) => (output += d.toString()));
      child.stderr.on('data', (d) => (output += d.toString()));
      const timer = setTimeout(() => {
        child.kill();
        resolve({ exited: false, output });
      }, ms);
      child.on('exit', () => {
        clearTimeout(timer);
        resolve({ exited: true, output });
      });
    });
  }

  // Today's bug (#120): opencode has no --model flag, so passing one makes the CLI die within milliseconds printing
  // its own --help text ("Help requested" / a ShowHelp error and the USAGE dump), instead of starting the session.
  const diedOnArgs = (r: { exited: boolean; output: string }) => /Help requested|ShowHelp/.test(r.output) || (r.exited && /USAGE\s+opencode <subcommand>/.test(r.output));

  it.skipIf(!cmd)('gets a custom provider past argument parsing', async () => {
    const launch = launchArgs('local-qwen', { ...base, model: `${provider.id}/${provider.model}`, provider });
    expect(diedOnArgs(await tryLaunch(launch))).toBe(false);
  }, 10_000);

  it.skipIf(!cmd)('gets a built-in OpenCode agent with a model past argument parsing', async () => {
    const launch = launchArgs('opencode', { ...base, model: 'anthropic/claude-sonnet-5' });
    expect(diedOnArgs(await tryLaunch(launch))).toBe(false);
  }, 10_000);
});

describe('newScreenshots', () => {
  it("picks up the images a browser saved, oldest first, once they're written and only once", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-browser-'));
    const later = Date.now() + 5000;
    for (const f of ['page-2026-09-29T10-00-02-000Z.jpeg', 'page-2026-09-29T10-00-01-000Z.png', 'page-2026-09-29T10-00-00-000Z.yml']) fs.writeFileSync(path.join(dir, f), 'x');
    const seen = new Set<string>();
    expect(newScreenshots(dir, seen)).toEqual([]); // just written: may still be in progress
    const found = newScreenshots(dir, seen, later);
    expect(found.map((s) => [s.name, s.mime])).toEqual([
      ['page-2026-09-29T10-00-01-000Z.png', 'image/png'],
      ['page-2026-09-29T10-00-02-000Z.jpeg', 'image/jpeg'],
    ]);
    seen.add(found[0].name);
    expect(newScreenshots(dir, seen, later).map((s) => s.name)).toEqual(['page-2026-09-29T10-00-02-000Z.jpeg']);
    expect(newScreenshots(path.join(dir, 'missing'), seen, later)).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
