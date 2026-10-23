import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionReader } from '../src/cli/service';
import type { Settings } from '../src/shared/types';

let temp: string;
let project: string;
let outside: string;
let settings: Settings;
const PRIVATE_TEXT = 'PRIVATE_TRANSCRIPT_MARKER';
const OUTSIDE_FILE = 'OUT_OF_SCOPE_METADATA';

beforeEach(async () => {
  temp = await mkdtemp(join(tmpdir(), 'agentlens-tree-scope-'));
  project = join(temp, 'app');
  outside = join(temp, 'app-other');
  await Promise.all([mkdir(join(project, '.git'), { recursive: true }), mkdir(join(outside, '.git'), { recursive: true })]);
  settings = {
    claudeSessionsDir: join(temp, 'claude'), codexSessionsDir: join(temp, 'codex'),
    activeWindowSeconds: 45, pricing: {}, notifications: false, theme: 'system', claudeBinary: '', allowPrMerge: false,
  };
});

afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

async function rollout(id: string, options: { cwd?: string; parent?: string; input?: number; at?: number; path?: string } = {}): Promise<string> {
  const cwd = options.cwd ?? project;
  const at = options.at ?? Date.now() - 5000;
  const timestamp = (offset: number) => new Date(at + offset).toISOString();
  const file = join(cwd, `${cwd === outside ? OUTSIDE_FILE : 'inside'}-${id}.ts`);
  const path = options.path ?? join(settings.codexSessionsDir, '2026', '10', '23', `rollout-${id}.jsonl`);
  const records = [
    { type: 'session_meta', timestamp: timestamp(0), payload: {
      id, cwd, timestamp: timestamp(0),
      ...(options.parent ? { source: { subagent: { thread_spawn: { parent_thread_id: options.parent } } } } : {}),
    } },
    { type: 'event_msg', timestamp: timestamp(1), payload: { type: 'user_message', message: `${PRIVATE_TEXT} prompt` } },
    { type: 'response_item', timestamp: timestamp(2), payload: { type: 'function_call', name: 'apply_patch', call_id: `${id}-edit`,
      arguments: JSON.stringify({ input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch` }) } },
    { type: 'response_item', timestamp: timestamp(3), payload: { type: 'function_call_output', call_id: `${id}-edit`, output: `${PRIVATE_TEXT} tool result` } },
    { type: 'event_msg', timestamp: timestamp(4), payload: { type: 'token_count', info: { total_token_usage: {
      input_tokens: options.input ?? 100, output_tokens: 10, cached_input_tokens: 0,
    } } } },
    { type: 'event_msg', timestamp: timestamp(5), payload: { type: 'task_complete', last_agent_message: `${PRIVATE_TEXT} answer` } },
  ];
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
  await utimes(path, new Date(at + 5), new Date(at + 5));
  return path;
}

function reader(): SessionReader {
  return new SessionReader({ settings, project });
}

describe('native Codex trees through the scoped CLI boundary', () => {
  it('filters child headers before root counts and excludes their detail/usage/file metadata', async () => {
    await Promise.all([
      rollout('root'), rollout('inside-child', { parent: 'root', input: 200 }),
      rollout('outside-child', { parent: 'root', cwd: outside, input: 9000 }),
    ]);
    const service = reader();
    const listed = await service.listRuns();
    expect(listed.runs).toMatchObject([{ id: 'root', agentCount: 2 }]);
    const inspected = await service.inspectRun('root');
    expect(inspected.agents.map((agent) => agent.id).sort()).toEqual(['inside-child', 'root']);
    expect(inspected.run.tokens?.input).toBe(300);
    const diagnosed = await service.diagnoseRun('root');
    expect(diagnosed.counts).toMatchObject({ agents: 2, filesTouched: 2, toolCalls: 2 });
    const output = JSON.stringify({ listed, inspected, diagnosed });
    expect(output).not.toContain('outside-child');
    expect(output).not.toContain(OUTSIDE_FILE);
    expect(output).not.toContain(PRIVATE_TEXT);
    expect((await service.doctor()).sources.find((source) => source.provider === 'codex')?.runsInScope).toBe(1);
  });

  it('promotes an accepted subtree when its native parent is outside the configured project', async () => {
    await Promise.all([
      rollout('outside-parent', { cwd: outside, input: 9000 }),
      rollout('child', { parent: 'outside-parent', input: 200 }),
      rollout('grandchild', { parent: 'child', input: 300 }),
    ]);
    const service = reader();
    expect((await service.listRuns()).runs).toMatchObject([{ id: 'child', agentCount: 2 }]);
    const inspected = await service.inspectRun('child');
    expect(inspected.agents).toMatchObject([
      { id: 'child', role: 'main', depth: 0 },
      { id: 'grandchild', role: 'subagent', parentId: 'child', depth: 1 },
    ]);
    expect(inspected.agents[0]?.parentId).toBeUndefined();
    expect(inspected.run.tokens?.input).toBe(500);
    expect(JSON.stringify(inspected)).not.toContain('outside-parent');
    await expect(service.inspectRun('outside-parent')).rejects.toThrow('Run not found in the configured project');
  });

  it('rechecks a child that changes project after its tree has been cached', async () => {
    await Promise.all([rollout('root'), rollout('moving-child', { parent: 'root', input: 200 })]);
    const service = reader();
    expect((await service.listRuns()).runs[0]?.agentCount).toBe(2);
    await rollout('moving-child', { parent: 'root', cwd: outside, input: 9000 });
    const inspected = await service.inspectRun('root');
    expect(inspected.agents.map((agent) => agent.id)).toEqual(['root']);
    expect(inspected.run.tokens?.input).toBe(100);
    expect((await service.diagnoseRun('root')).counts.agents).toBe(1);
    expect(JSON.stringify(inspected)).not.toContain(OUTSIDE_FILE);
  });

  it('filters scope before a fresher duplicate native ID can displace the accepted file', async () => {
    const at = Date.now() - 10_000;
    await Promise.all([
      rollout('root', { at }), rollout('child', { parent: 'root', input: 200, at }),
      rollout('child', { parent: 'root', cwd: outside, input: 9000, at: at + 5000,
        path: join(settings.codexSessionsDir, '2026', '10', '23', 'rollout-child-new-copy.jsonl') }),
    ]);
    const service = reader();
    expect((await service.listRuns()).runs).toMatchObject([{ id: 'root', agentCount: 2 }]);
    const inspected = await service.inspectRun('root');
    expect(inspected.run.tokens?.input).toBe(300);
    expect(inspected.agents.find((agent) => agent.id === 'child')?.filesTouched).toEqual(['inside-child.ts']);
    expect(JSON.stringify(inspected)).not.toContain(OUTSIDE_FILE);
  });

  it('retains an accepted grandchild without leaking a parent removed by full-read scope checks', async () => {
    await Promise.all([
      rollout('root'), rollout('middle', { parent: 'root', input: 200 }), rollout('grandchild', { parent: 'middle', input: 300 }),
    ]);
    const service = reader();
    expect((await service.listRuns()).runs[0]?.agentCount).toBe(3);
    await rollout('middle', { parent: 'root', cwd: outside, input: 9000 });
    const inspected = await service.inspectRun('root');
    expect(inspected.agents).toMatchObject([
      { id: 'root', role: 'main', depth: 0 },
      { id: 'grandchild', role: 'subagent', parentId: 'root', depth: 1 },
    ]);
    expect(inspected.run.tokens?.input).toBe(400);
    expect(JSON.stringify(inspected)).not.toContain('middle');
    expect(JSON.stringify(inspected)).not.toContain(OUTSIDE_FILE);
  });
});
