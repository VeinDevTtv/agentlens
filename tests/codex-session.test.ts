import { describe, expect, it } from 'vitest';
import { codexParentMap, mergeCodexSessions, parseCodexSession, summarizeCodexTree } from '../src/core';
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

  it('reads current top-level and source parent linkage plus legacy thread_source metadata', () => {
    const parseMeta = (payload: Record<string, unknown>) => parseCodexSession({ filePath: '/c', text: JSON.stringify({ type: 'session_meta', payload: { id: 'child', ...payload } }), now: LAST, activeWindowMs: MINUTE });
    expect(parseMeta({ parent_thread_id: 'direct', source: { subagent: { thread_spawn: { parent_thread_id: 'fallback' } } } }).parentThreadId).toBe('direct');
    expect(parseMeta({ source: { subagent: { thread_spawn: { parent_thread_id: 'source-parent' } } }, thread_source: 'subagent' }).parentThreadId).toBe('source-parent');
    expect(parseMeta({ thread_source: { subagent: { parent_thread_id: 'legacy-parent' } } }).parentThreadId).toBe('legacy-parent');
  });

  it('finishes a child at task_complete and restarts it on another turn', () => {
    const text = fixture('codex-tree-child.jsonl');
    const now = Date.parse('2026-03-02T14:01:06.000Z');
    expect(parseCodexSession({ filePath: '/child', text, now, activeWindowMs: MINUTE }).run.status).toBe('finished');
    const resumed = text + '\n' + JSON.stringify({ timestamp: '2026-03-02T14:01:06.000Z', type: 'event_msg', payload: { type: 'task_started' } });
    expect(parseCodexSession({ filePath: '/child', text: resumed, now, activeWindowMs: MINUTE }).run.status).toBe('running');
  });

  it('does not confuse the word error in successful tool output with a failed call', () => {
    const parseOutput = (output: unknown) => parseCodexSession({ filePath: '/c', text: [
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'c', arguments: '{}' } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'c', output } },
    ].map((line) => JSON.stringify(line)).join('\n'), now: LAST, activeWindowMs: MINUTE }).agents[0]?.toolCalls[0]?.isError;
    expect(parseOutput('This file implements error handling.')).not.toBe(true);
    expect(parseOutput(JSON.stringify({ output: 'error handling tests pass', metadata: { exit_code: 0 } }))).not.toBe(true);
    expect(parseOutput(JSON.stringify({ output: 'failed', metadata: { exit_code: 2 } }))).toBe(true);
    expect(parseOutput('Process exited with code 1')).toBe(true);
    expect(parseOutput('Process exited with code 0\nOutput:\nDocumentation example:\nProcess exited with code 1')).not.toBe(true);
  });

  it('requires explicit failure metadata for unstructured non-shell errors', () => {
    const parseOutput = (output: unknown) => parseCodexSession({ filePath: '/c', text: [
      { type: 'response_item', timestamp: '2026-03-02T14:00:00.000Z', payload: { type: 'function_call', name: 'read_file', call_id: 'read', arguments: '{}' } },
      { type: 'response_item', timestamp: '2026-03-02T14:00:01.000Z', payload: { type: 'function_call_output', call_id: 'read', output } },
    ].map((line) => JSON.stringify(line)).join('\n'), now: LAST, activeWindowMs: MINUTE }).agents[0];
    // This may be a real error or quoted file content; text alone cannot tell.
    const unstructured = parseOutput('Error: ENOENT: no such file or directory');
    expect(unstructured?.toolCalls[0]?.isError).toBeUndefined();
    expect(unstructured?.timeline.find((event) => event.kind === 'tool-result')?.isError).toBeUndefined();
    const explicit = parseOutput({ is_error: true, output: 'Error: ENOENT: no such file or directory' });
    expect(explicit?.toolCalls[0]?.isError).toBe(true);
    expect(explicit?.timeline.find((event) => event.kind === 'tool-result')?.isError).toBe(true);
  });

  it('merges nested rollouts, task prompts, activity and token totals', () => {
    const now = Date.parse('2026-03-02T14:02:05.000Z');
    const parse = (name: string) => parseCodexSession({ filePath: `/${name}`, text: fixture(name), now, activeWindowMs: MINUTE });
    const root = parse('codex-tree-root.jsonl');
    const child = parse('codex-tree-child.jsonl');
    const grandchild = parse('codex-tree-grandchild.jsonl');
    const detail = mergeCodexSessions(root, [grandchild, child]);
    expect(detail.run.id).toBe('codex-root');
    expect(detail.run.title).toBe('Improve the test suite');
    expect(detail.run.agentCount).toBe(3);
    expect(detail.run.tokens).toEqual({ input: 480, output: 60, cacheRead: 120, cacheWrite: 0 });
    expect(detail.run.status).toBe('running');
    expect(detail.run.lastActivityAt).toBe(Date.parse('2026-03-02T14:02:04.000Z'));
    expect(detail.agents.map((agent) => [agent.id, agent.parentId, agent.depth, agent.runId])).toEqual([
      ['codex-root', undefined, 0, 'codex-root'],
      ['codex-child', 'codex-root', 1, 'codex-root'],
      ['codex-grandchild', 'codex-child', 2, 'codex-root'],
    ]);
    expect(detail.agents[1]?.title).toBe('Audit the parser tests');
    expect(detail.agents[1]?.prompt).toBe('Audit the parser tests');
    expect(detail.agents[1]?.agentType).toBe('explorer');
    expect(detail.agents[1]?.spawnToolUseId).toBe('spawn-child');
    expect(detail.agents[1]?.status).toBe('finished');
    expect(detail.agents[2]?.status).toBe('running');
    expect(detail.agents[2]?.agentType).toBe('worker');
  });

  it('keeps missing parents visible and breaks cycles without hanging', () => {
    const parents = codexParentMap([
      { id: 'a', parentThreadId: 'b' },
      { id: 'b', parentThreadId: 'a' },
      { id: 'orphan', parentThreadId: 'missing' },
      { id: 'self', parentThreadId: 'self' },
    ]);
    expect([...parents]).toEqual([['b', 'a']]);
    const child = parseCodexSession({ filePath: '/child', text: fixture('codex-tree-child.jsonl'), now: LAST, activeWindowMs: MINUTE });
    const orphan = mergeCodexSessions(child, []);
    expect(orphan.agents[0]?.role).toBe('main');
    expect(orphan.agents[0]?.depth).toBe(0);
    expect(orphan.agents[0]?.parentId).toBeUndefined();
  });

  it('preserves depth when a missing middle rollout is attached to the root', () => {
    const parse = (name: string) => parseCodexSession({ filePath: `/${name}`, text: fixture(name), now: LAST, activeWindowMs: MINUTE });
    const great = parseCodexSession({ filePath: '/great', text: JSON.stringify({ type: 'session_meta', payload: { id: 'great', parent_thread_id: 'codex-grandchild' } }), now: LAST, activeWindowMs: MINUTE });
    const detail = mergeCodexSessions(parse('codex-tree-root.jsonl'), [parse('codex-tree-grandchild.jsonl'), great]);
    expect(detail.agents.map((agent) => [agent.id, agent.parentId, agent.depth])).toEqual([
      ['codex-root', undefined, 0],
      ['codex-grandchild', 'codex-root', 1],
      ['great', 'codex-grandchild', 2],
    ]);
  });

  it('keeps a tree idle while a descendant still has unfinished work', () => {
    const now = Date.parse('2026-03-02T15:00:00.000Z');
    const root = parseCodexSession({ filePath: '/root', text: fixture('codex-tree-root.jsonl'), now, activeWindowMs: MINUTE }).run;
    const child = { ...root, id: 'child', status: 'idle' as const, lastActivityAt: now - 2 * MINUTE };
    expect(root.status).toBe('finished');
    expect(summarizeCodexTree(root, [child]).status).toBe('idle');
    expect(summarizeCodexTree(root, [{ ...child, status: 'finished' }]).status).toBe('finished');
    expect(summarizeCodexTree(root, [{ ...child, status: 'errored' }]).status).toBe('errored');
    expect(summarizeCodexTree({ ...root, status: 'errored' }, [{ ...child, status: 'running' }]).status).toBe('running');
  });

  it('counts a native thread only once when duplicate rollouts are supplied', () => {
    const parse = (name: string) => parseCodexSession({ filePath: `/${name}`, text: fixture(name), now: LAST, activeWindowMs: MINUTE });
    const root = parse('codex-tree-root.jsonl');
    const child = parse('codex-tree-child.jsonl');
    const detail = mergeCodexSessions(root, [child, root, child]);
    expect(detail.agents.map((agent) => agent.id)).toEqual(['codex-root', 'codex-child']);
    expect(detail.run.agentCount).toBe(2);
    expect(detail.run.tokens).toEqual({ input: 240, output: 30, cacheRead: 60, cacheWrite: 0 });
    expect(summarizeCodexTree(root.run, [root.run, child.run, child.run]).tokens).toEqual(detail.run.tokens);
  });

  it('assembles a deep tree iteratively even when children arrive before their parents', () => {
    const parse = (id: string, parent?: string) => parseCodexSession({ filePath: `/${id}`, text: JSON.stringify({ type: 'session_meta', payload: { id, parent_thread_id: parent } }), now: LAST, activeWindowMs: MINUTE });
    const root = parse('0');
    const children = Array.from({ length: 4_000 }, (_, i) => parse(String(i + 1), String(i))).reverse();
    const detail = mergeCodexSessions(root, children);
    expect(detail.agents).toHaveLength(4_001);
    expect(detail.agents.at(-1)).toMatchObject({ id: '4000', parentId: '3999', depth: 4_000, runId: '0' });
  });
});
