import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { codexHeader, codexRunHeader, discoverAll, loadRunDetail, RunIdentityError } from '../src/main/discovery';
import type { Settings } from '../src/shared/types';
import { fixture } from './helpers';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function treeFixture(): Promise<Settings> {
  const dir = await mkdtemp(join(tmpdir(), 'agentlens-tree-'));
  directories.push(dir);
  const codexSessionsDir = join(dir, 'codex');
  const day = join(codexSessionsDir, '2026', '03', '02');
  await mkdir(day, { recursive: true });
  for (const name of ['root', 'child', 'grandchild']) await writeFile(join(day, `rollout-${name}.jsonl`), fixture(`codex-tree-${name}.jsonl`));
  return { claudeSessionsDir: join(dir, 'claude'), codexSessionsDir, activeWindowSeconds: 45, pricing: {}, notifications: false, theme: 'system', claudeBinary: '', allowPrMerge: false };
}

describe('Codex tree discovery', () => {
  it('waits for a complete metadata id before registering a new rollout', async () => {
    const settings = await treeFixture();
    const path = join(settings.codexSessionsDir, '2026', '03', '02', 'rollout-new.jsonl');
    const record = JSON.stringify({ type: 'session_meta', payload: { id: 'new-child', cwd: '/home/dev/work/project', parent_thread_id: 'codex-root' } });
    await writeFile(path, record.slice(0, -2));
    expect(await codexHeader(path, settings)).toBeUndefined();
    await writeFile(path, JSON.stringify({ type: 'session_meta', payload: { id: '' } }));
    expect(await codexHeader(path, settings)).toBeUndefined();
    const partial = await discoverAll(settings);
    expect(partial.locations.has(path)).toBe(false);
    expect(partial.locations.has('new-child')).toBe(false);
    await writeFile(path, record + '\n');
    expect((await codexHeader(path, settings))?.run.id).toBe('new-child');
    const complete = await discoverAll(settings);
    expect(complete.locations.get('new-child')?.rootRunId).toBe('codex-root');
    expect(complete.runs.find((run) => run.id === 'codex-root')?.agentCount).toBe(4);
  });

  it('lists one run and keeps all descendant paths addressable for watcher updates', async () => {
    const settings = await treeFixture();
    const result = await discoverAll(settings);
    expect(result.runs.map((run) => run.id)).toEqual(['codex-root']);
    expect(result.runs[0]?.agentCount).toBe(3);
    expect(result.runs[0]?.tokensLoaded).toBe(false);
    expect(result.locations.size).toBe(3);
    expect(result.locations.get('codex-grandchild')?.rootRunId).toBe('codex-root');
    expect(result.sources.find((source) => source.provider === 'codex')?.sessionCount).toBe(1);
    const location = result.locations.get('codex-root');
    expect(location?.subagentLocations).toHaveLength(2);
    if (!location) throw new Error('Missing root');
    const now = Date.parse('2026-03-02T14:02:05.000Z');
    const detail = await loadRunDetail(location, settings, now);
    const header = await codexRunHeader(location, settings, now);
    expect(detail.agents).toHaveLength(3);
    expect(detail.run.tokens).toEqual({ input: 480, output: 60, cacheRead: 120, cacheWrite: 0 });
    expect(header?.run.agentCount).toBe(3);
    expect(header?.run.status).toBe('running');
    expect(header?.run.lastActivityAt).toBe(Date.parse('2026-03-02T14:02:04.000Z'));
    expect(header?.run.tokensLoaded).toBe(false);
  });

  it('promotes a missing-parent subtree to its own visible run', async () => {
    const settings = await treeFixture();
    await rm(join(settings.codexSessionsDir, '2026', '03', '02', 'rollout-root.jsonl'));
    const result = await discoverAll(settings);
    expect(result.runs.map((run) => run.id)).toEqual(['codex-child']);
    expect(result.locations.get('codex-grandchild')?.rootRunId).toBe('codex-child');
    const location = result.locations.get('codex-child');
    if (!location) throw new Error('Missing orphan root');
    const detail = await loadRunDetail(location, settings);
    expect(detail.agents[0]?.parentId).toBeUndefined();
    expect(detail.agents[1]?.parentId).toBe('codex-child');
    expect(detail.agents[1]?.depth).toBe(1);
  });

  it('selects the freshest file for duplicate native thread ids without double-counting', async () => {
    const settings = await treeFixture();
    const copy = join(settings.codexSessionsDir, '2026', '03', '02', 'rollout-child-copy.jsonl');
    await writeFile(copy, fixture('codex-tree-child.jsonl') + '\n' + JSON.stringify({ timestamp: '2026-03-02T14:03:00.000Z', type: 'event_msg', payload: { type: 'agent_message', message: 'Updated result' } }));
    const result = await discoverAll(settings);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]?.agentCount).toBe(3);
    expect(result.locations.size).toBe(3);
    expect(result.locations.get('codex-child')?.filePath).toBe(copy);
    const root = result.locations.get('codex-root');
    if (!root) throw new Error('Missing root');
    expect((await loadRunDetail(root, settings)).run.tokens).toEqual({ input: 480, output: 60, cacheRead: 120, cacheWrite: 0 });
  });

  it('does not add a path-based child identity when an existing rollout is partly rewritten', async () => {
    const settings = await treeFixture();
    const result = await discoverAll(settings);
    const root = result.locations.get('codex-root');
    const child = result.locations.get('codex-child');
    if (!root || !child) throw new Error('Missing tree');
    await writeFile(child.filePath, '{"type":"session_meta","payload":');
    const detail = await loadRunDetail(root, settings);
    expect(detail.agents.map((agent) => agent.id)).toEqual(['codex-root', 'codex-grandchild']);
    expect(detail.agents[1]?.parentId).toBe('codex-root');
    expect((await codexRunHeader(root, settings))?.run.agentCount).toBe(2);
    await writeFile(root.filePath, '{"type":"session_meta","payload":');
    await expect(loadRunDetail(root, settings)).rejects.toThrow(RunIdentityError);
    expect(await codexRunHeader(root, settings)).toBeUndefined();
    await writeFile(root.filePath, JSON.stringify({ type: 'session_meta', payload: { id: 'replacement' } }));
    expect(await codexRunHeader(root, settings)).toBeUndefined();
  });

});
