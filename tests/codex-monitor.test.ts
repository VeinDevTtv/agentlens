import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { appendFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as discovery from '../src/main/discovery';
import { Monitor } from '../src/main/monitor';
import type { RunDetail, Settings } from '../src/shared/types';
import { fixture, MINUTE } from './helpers';

vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));

const NOW = Date.parse('2026-03-02T14:02:05.000Z');
const directories: string[] = [];
const monitors: Monitor[] = [];

async function eventually(assertion: () => void): Promise<void> {
  await vi.waitFor(assertion, { timeout: 3_000, interval: 20 });
}
let watcher: EventEmitter;

beforeEach(() => {
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(chokidar.watch).mockReturnValue(watcher as unknown as FSWatcher);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function setup(withClaude = false) {
  const dir = await mkdtemp(join(tmpdir(), 'agentlens-codex-monitor-'));
  directories.push(dir);
  const day = join(dir, 'codex', '2026', '03', '02');
  await mkdir(day, { recursive: true });
  for (const name of ['root', 'child', 'grandchild']) await writeFile(join(day, `rollout-${name}.jsonl`), fixture(`codex-tree-${name}.jsonl`));
  const settings: Settings = { claudeSessionsDir: join(dir, 'claude'), codexSessionsDir: join(dir, 'codex'), activeWindowSeconds: 45, pricing: {}, notifications: false, theme: 'system', claudeBinary: '', allowPrMerge: false };
  if (withClaude) {
    const project = join(settings.claudeSessionsDir, 'project');
    await mkdir(project, { recursive: true });
    await writeFile(join(project, 'sess-main-1.jsonl'), fixture('claude-main.jsonl'));
  }
  const monitor = new Monitor(settings);
  monitors.push(monitor);
  await monitor.start();
  return { monitor, day, settings };
}

function siblingText(): string {
  // Older than the latest grandchild event: adding/removing it changes totals
  // without changing the tree's lastActivityAt.
  return [
    { type: 'session_meta', payload: { id: 'sibling', parent_thread_id: 'codex-root', cwd: '/home/dev/work/project' } },
    { type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 10, output_tokens: 1 } } } },
    { type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Sibling done' } },
  ].map((line) => JSON.stringify({ timestamp: '2026-03-02T14:01:30.000Z', ...line })).join('\n') + '\n';
}

describe('Codex tree watcher integration', () => {
  it('routes nested child changes and native child-id requests to the root detail', async () => {
    const { monitor, day } = await setup();
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-root']);
    expect((await monitor.loadRun('codex-grandchild'))?.run.id).toBe('codex-root');
    expect((await monitor.loadRunTokens('codex-child'))?.agentCount).toBe(3);
    monitor.watchRun('codex-grandchild');
    const emitted: RunDetail[] = [];
    monitor.on('run', (detail) => emitted.push(detail));
    const path = join(day, 'rollout-grandchild.jsonl');
    await appendFile(path, '\n' + JSON.stringify({ timestamp: '2026-03-02T14:02:05.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Nested tests complete' } }));
    watcher.emit('change', path);
    await eventually(() => expect(emitted.at(-1)?.agents.find((agent) => agent.id === 'codex-grandchild')?.lastAssistantText).toBe('Nested tests complete'));
    expect(emitted.at(-1)?.run).toMatchObject({ id: 'codex-root', agentCount: 3, status: 'idle', lastActivityAt: NOW });
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-root']);
  });

  it('refreshes the selected tree when a child is added and removed', async () => {
    const { monitor, day } = await setup();
    monitor.watchRun('codex-root');
    await monitor.loadRun('codex-root');
    const emitted: RunDetail[] = [];
    monitor.on('run', (detail) => emitted.push(detail));
    const path = join(day, 'rollout-sibling.jsonl');
    await writeFile(path, siblingText());
    watcher.emit('add', path);
    await eventually(() => expect(emitted.at(-1)?.run.agentCount).toBe(4));
    expect(emitted.at(-1)?.run.tokens?.input).toBe(490);
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-root']);
    await rm(path);
    watcher.emit('unlink', path);
    await eventually(() => expect(emitted.at(-1)?.run.agentCount).toBe(3));
    expect(emitted.at(-1)?.run.tokens?.input).toBe(480);
  });

  it('invalidates unselected tree totals when membership changes at the same timestamp', async () => {
    const { monitor, day } = await setup();
    const before = await monitor.loadRunTokens('codex-root');
    expect(before?.tokens?.input).toBe(480);
    const path = join(day, 'rollout-sibling.jsonl');
    await writeFile(path, siblingText());
    watcher.emit('add', path);
    await eventually(() => expect(monitor.snapshot().runs[0]?.agentCount).toBe(4));
    expect(monitor.snapshot().runs[0]?.lastActivityAt).toBe(before?.lastActivityAt);
    expect(monitor.snapshot().runs[0]?.tokensLoaded).toBe(false);
    expect((await monitor.loadRunTokens('codex-root'))?.tokens?.input).toBe(490);
  });

  it('waits out a partial new metadata line without creating a duplicate run', async () => {
    const { monitor, day } = await setup();
    let snapshots = 0;
    monitor.on('snapshot', () => snapshots++);
    const path = join(day, 'rollout-sibling.jsonl');
    await writeFile(path, '{"type":"session_meta","payload":');
    watcher.emit('add', path);
    await eventually(() => expect(snapshots).toBeGreaterThan(0));
    expect(monitor.snapshot().runs).toHaveLength(1);
    expect(monitor.snapshot().runs[0]?.agentCount).toBe(3);
    await writeFile(path, siblingText());
    watcher.emit('change', path);
    await eventually(() => expect(monitor.snapshot().runs[0]?.agentCount).toBe(4));
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-root']);
  });

  it('promotes remaining descendants after an intermediate rollout disappears', async () => {
    const { monitor, day } = await setup();
    monitor.watchRun('codex-root');
    const emitted: RunDetail[] = [];
    monitor.on('run', (detail) => emitted.push(detail));
    const path = join(day, 'rollout-child.jsonl');
    await rm(path);
    watcher.emit('unlink', path);
    await eventually(() => expect(emitted.at(-1)?.run.agentCount).toBe(1));
    expect(monitor.snapshot().runs.map((run) => run.id).sort()).toEqual(['codex-grandchild', 'codex-root']);
    expect((await monitor.loadRun('codex-grandchild'))?.agents[0]).toMatchObject({ id: 'codex-grandchild', role: 'main', depth: 0 });
  });

  it('does not let an old child refresh overwrite a newly discovered tree', async () => {
    const { monitor, day } = await setup();
    monitor.watchRun('codex-root');
    const original = discovery.loadRunDetail;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    let finished: Promise<RunDetail> | undefined;
    vi.spyOn(discovery, 'loadRunDetail').mockImplementationOnce((...args) => {
      finished = (async () => {
        const detail = await original(...args);
        started = true;
        await held;
        return detail;
      })();
      return finished;
    });
    const emitted: RunDetail[] = [];
    monitor.on('run', (detail) => emitted.push(detail));
    watcher.emit('change', join(day, 'rollout-grandchild.jsonl'));
    await eventually(() => expect(started).toBe(true));
    const path = join(day, 'rollout-sibling.jsonl');
    await writeFile(path, siblingText());
    watcher.emit('add', path);
    await eventually(() => expect(emitted.at(-1)?.run.agentCount).toBe(4));
    release?.();
    await finished;
    expect(emitted.map((detail) => detail.run.agentCount)).toEqual([4]);
    expect(monitor.snapshot().runs[0]?.agentCount).toBe(4);
  });

  it('continues aging idle Codex trees until they finish', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { monitor } = await setup();
    vi.mocked(Date.now).mockReturnValue(NOW + 2 * MINUTE);
    await vi.advanceTimersByTimeAsync(15_000);
    await eventually(() => expect(monitor.snapshot().runs[0]?.status).toBe('idle'));
    vi.mocked(Date.now).mockReturnValue(NOW + 31 * MINUTE);
    await vi.advanceTimersByTimeAsync(15_000);
    await eventually(() => expect(monitor.snapshot().runs[0]?.status).toBe('finished'));
  });

  it('keeps a concurrent Claude load valid when only Codex tree membership changes', async () => {
    const { monitor, day } = await setup(true);
    const original = discovery.loadRunDetail;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    vi.spyOn(discovery, 'loadRunDetail').mockImplementationOnce(async (...args) => {
      const detail = await original(...args);
      started = true;
      await held;
      return detail;
    });
    const request = monitor.loadRun('sess-main-1');
    try {
      await eventually(() => expect(started).toBe(true));
      const path = join(day, 'rollout-sibling.jsonl');
      await writeFile(path, siblingText());
      watcher.emit('add', path);
      await eventually(() => expect(monitor.snapshot().runs.find((run) => run.id === 'codex-root')?.agentCount).toBe(4));
    } finally {
      release?.();
    }
    expect((await request)?.run.id).toBe('sess-main-1');
    expect(monitor.snapshot().runs.find((run) => run.id === 'sess-main-1')?.tokensLoaded).toBe(true);
  });

  it('retries a selected detail against the current tree after a public rescan', async () => {
    const { monitor, day } = await setup();
    monitor.watchRun('codex-root');
    const original = discovery.loadRunDetail;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const load = vi.spyOn(discovery, 'loadRunDetail').mockImplementationOnce(async (...args) => {
      const detail = await original(...args);
      started = true;
      await held;
      return detail;
    });
    const request = monitor.loadRun('codex-root');
    try {
      await eventually(() => expect(started).toBe(true));
      await appendFile(join(day, 'rollout-grandchild.jsonl'), '\n' + JSON.stringify({ timestamp: '2026-03-02T14:02:05.000Z', type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'Latest result after rescan' } }));
      await monitor.rescan();
    } finally {
      release?.();
    }
    const detail = await request;
    expect(detail?.run.id).toBe('codex-root');
    expect(detail?.agents.find((agent) => agent.id === 'codex-grandchild')?.lastAssistantText).toBe('Latest result after rescan');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it.each(['removed root', 'changed source'] as const)('does not retry into an unrelated location after a %s', async (change) => {
    const { monitor, day, settings } = await setup();
    const original = discovery.loadRunDetail;
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const load = vi.spyOn(discovery, 'loadRunDetail').mockImplementationOnce(async (...args) => {
      const detail = await original(...args);
      started = true;
      await held;
      return detail;
    });
    const request = monitor.loadRun('codex-root');
    try {
      await eventually(() => expect(started).toBe(true));
      if (change === 'removed root') {
        await rm(join(day, 'rollout-root.jsonl'));
        await monitor.rescan();
      } else {
        const replacement = settings.codexSessionsDir + '-replacement';
        await mkdir(replacement);
        await writeFile(join(replacement, 'root.jsonl'), fixture('codex-tree-root.jsonl').replaceAll('/home/dev/work/project', '/home/dev/replacement'));
        await monitor.updateSettings({ ...settings, codexSessionsDir: replacement });
      }
    } finally {
      release?.();
    }
    expect(await request).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(1);
    if (change === 'removed root') expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-child']);
    else expect(monitor.snapshot().runs[0]?.cwd).toBe('/home/dev/replacement');
  });
});
