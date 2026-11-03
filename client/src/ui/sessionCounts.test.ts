import { describe, expect, it } from 'vitest';
import type { CliView } from '../../../shared/types';
import { sessionsLabel, sessionsTotal } from './sessionCounts';

const clis: CliView[] = [
  { id: 'claude', label: 'Claude Code', installed: true, version: null, integrated: true },
  { id: 'codex', label: 'Codex', installed: true, version: null, integrated: false },
  { id: 'opencode', label: 'OpenCode', installed: true, version: null, integrated: false },
];

describe('sessionsTotal', () => {
  it('sums every coding agent', () => {
    expect(sessionsTotal({ claude: 2, opencode: 1 })).toBe(3);
    expect(sessionsTotal({})).toBe(0);
  });
});

describe('sessionsLabel', () => {
  it('shows a limit only for coding agents that have one, busiest first', () => {
    expect(sessionsLabel(clis, { claude: 1, opencode: 2 }, { claude: 3 })).toBe('2 OpenCode · 1/3 Claude Code');
  });

  it('includes a capped coding agent with nothing running', () => {
    expect(sessionsLabel(clis, {}, { codex: 5 })).toBe('0/5 Codex');
  });

  it('is "0" with nothing running and no limits', () => {
    expect(sessionsLabel(clis, {}, {})).toBe('0');
  });
});
