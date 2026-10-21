import { describe, expect, it } from 'vitest';
import { parseCodexSession } from '../src/core';
import { fixture, MINUTE } from './helpers';

const LAST = Date.parse('2026-03-02T14:00:12.600Z');

describe('parseCodexSession', () => {
  it('names the project from the repository URL and the run from the first prompt', () => {
    const { run, agents } = parseCodexSession({ filePath: '/codex/rollout.jsonl', text: fixture('codex-rollout.jsonl'), now: LAST + 2 * MINUTE, activeWindowMs: MINUTE });
    expect(run.id).toBe('019d-codex-1');
    expect(run.provider).toBe('codex');
    expect(run.projectName).toBe('billing-service');
    expect(run.title).toBe('Add retry logic to the Stripe webhook handler and make the…');
    expect(run.gitBranch).toBe('main');
    expect(run.model).toBe('gpt-5-codex');
    expect(agents).toHaveLength(1);
    expect(agents[0]?.role).toBe('main');
  });

  it('humanizes exec_command and apply_patch calls and tracks files touched', () => {
    const { agents } = parseCodexSession({ filePath: '/codex/rollout.jsonl', text: fixture('codex-rollout.jsonl'), now: LAST, activeWindowMs: MINUTE });
    const agent = agents[0];
    expect(agent?.toolCalls.map((c) => c.summary)).toEqual(['Running npm test', 'Editing src/webhooks/stripe.ts and 1 more']);
    expect(agent?.toolCalls[0]?.isError).toBe(true);
    expect(agent?.filesTouched).toEqual(['src/webhooks/stripe.ts', 'src/webhooks/retry.ts']);
    expect(agent?.currentAction).toBe('Editing src/webhooks/stripe.ts and 1 more');
  });

  it('reads cumulative token usage and splits cached input', () => {
    const { run } = parseCodexSession({ filePath: '/codex/rollout.jsonl', text: fixture('codex-rollout.jsonl'), now: LAST, activeWindowMs: MINUTE });
    expect(run.tokens).toEqual({ input: 4000, output: 900, cacheRead: 8000, cacheWrite: 0 });
    expect(run.tokensLoaded).toBe(true);
  });

  it('is idle after task_complete once the active window passes, running inside it', () => {
    expect(parseCodexSession({ filePath: '/c', text: fixture('codex-rollout.jsonl'), now: LAST + 10_000, activeWindowMs: MINUTE }).run.status).toBe('running');
    expect(parseCodexSession({ filePath: '/c', text: fixture('codex-rollout.jsonl'), now: LAST + 5 * MINUTE, activeWindowMs: MINUTE }).run.status).toBe('idle');
  });

  it('skips per-call detail in header mode but still lists the run', () => {
    const { run, agents } = parseCodexSession({ filePath: '/c', text: fixture('codex-rollout.jsonl'), now: LAST, activeWindowMs: MINUTE, headerOnly: true });
    expect(run.tokensLoaded).toBe(false);
    expect(run.title).toMatch(/^Add retry logic/);
    expect(agents[0]?.toolCallCount).toBe(0);
  });
});
