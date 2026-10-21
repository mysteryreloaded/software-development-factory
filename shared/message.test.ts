import { describe, expect, it } from 'vitest';
import { MESSAGE_MAX, messageProblem } from './message.ts';

describe('messageProblem', () => {
  it('refuses an empty or whitespace-only message', () => {
    expect(messageProblem('')).toBe('Empty message');
    expect(messageProblem('   \n\t  ')).toBe('Empty message');
  });

  it('takes a single character', () => {
    expect(messageProblem('x')).toBeNull();
  });

  it('takes exactly the limit', () => {
    expect(messageProblem('x'.repeat(MESSAGE_MAX))).toBeNull();
  });

  it('refuses one character over the limit', () => {
    expect(messageProblem('x'.repeat(MESSAGE_MAX + 1))).toBe('Message too long: 60,001 characters, the limit is 60,000');
  });

  it("doesn't count padding whitespace toward the limit", () => {
    expect(messageProblem(`  ${'x'.repeat(MESSAGE_MAX)}  `)).toBeNull();
    expect(messageProblem(`  ${'x'.repeat(MESSAGE_MAX + 1)}  `)).toBe('Message too long: 60,001 characters, the limit is 60,000');
  });
});
