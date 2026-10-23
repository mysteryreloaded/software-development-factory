import { describe, expect, it } from 'vitest';
import { checkRunOf, jobNeverStarted, readTwice } from './github.ts';

describe('readTwice', () => {
  it('tries a failed read once more', async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      if (calls === 1) throw new Error('gh pr list -R failed: timed out after 60 s');
      return [1, 2];
    };
    await expect(readTwice(read, 0)).resolves.toEqual([1, 2]);
    expect(calls).toBe(2);
  });

  it('gives up with the second error', async () => {
    let calls = 0;
    const read = async () => {
      calls++;
      throw new Error(`failure ${calls}`);
    };
    await expect(readTwice(read, 0)).rejects.toThrow('failure 2');
    expect(calls).toBe(2);
  });
});

describe('checkRunOf', () => {
  const run = (startedAt: string, completedAt: string | undefined, status = 'COMPLETED') => ({ name: 'build', status, conclusion: completedAt ? 'SUCCESS' : '', startedAt, completedAt });

  it('times the check runs from the first start to the last finish', () => {
    expect(checkRunOf([run('2026-10-04T17:38:00Z', '2026-10-04T17:38:42Z'), run('2026-10-04T17:38:08Z', '2026-10-04T17:41:01Z')])).toEqual({
      ms: (3 * 60 + 1) * 1000,
      doneAt: Date.parse('2026-10-04T17:41:01Z'),
    });
  });

  it('has nothing while a check still runs, without times, or without checks', () => {
    expect(checkRunOf([run('2026-10-04T17:38:00Z', '2026-10-04T17:38:42Z'), run('2026-10-04T17:38:08Z', undefined, 'IN_PROGRESS')])).toBeNull();
    expect(checkRunOf([{ context: 'Vercel', state: 'SUCCESS' }])).toBeNull();
    expect(checkRunOf([])).toBeNull();
    expect(checkRunOf(null)).toBeNull();
  });
});

describe('jobNeverStarted', () => {
  // Recorded shapes: GET /repos/{owner}/{repo}/actions/jobs/{job_id} and /check-runs/{job_id}/annotations.
  const billingAnnotations = [
    {
      path: '.github',
      start_line: 0,
      end_line: 0,
      annotation_level: 'failure',
      title: 'build',
      message: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.',
      raw_details: null,
    },
  ];
  const billingJob = { status: 'completed', conclusion: 'failure', steps: [], runner_id: null };

  const ranAnnotations = [{ path: 'src/toolbar.test.ts', start_line: 12, end_line: 12, annotation_level: 'failure', title: 'build', message: 'AssertionError: expected "nowrap" to be "wrap"', raw_details: null }];
  const ranJob = {
    status: 'completed',
    conclusion: 'failure',
    runner_id: 7,
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Run npm test', status: 'completed', conclusion: 'failure' },
    ],
  };

  it('recognises a job GitHub billing blocked from its annotation, even once the job record itself has no steps or runner', () => {
    expect(jobNeverStarted(billingJob, billingAnnotations)).toBe(true);
    expect(jobNeverStarted(null, billingAnnotations)).toBe(true); // the job lookup itself can fail while this still tells the story
  });

  it('recognises the same block from a missing runner and no steps, with no annotations yet', () => {
    expect(jobNeverStarted({ steps: [], runner_id: null }, [])).toBe(true);
  });

  it('is not never-started for a job that actually ran and failed', () => {
    expect(jobNeverStarted(ranJob, ranAnnotations)).toBe(false);
  });
});
