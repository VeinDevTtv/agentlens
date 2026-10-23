import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeCodexSessions, parseCodexSession } from '../src/core';
import * as discovery from '../src/main/discovery';
import { Monitor } from '../src/main/monitor';
import { useStore } from '../src/renderer/store';
import type { RunDetail, Settings } from '../src/shared/types';
import { fixture, MINUTE } from './helpers';

vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));

const NOW = Date.parse('2026-03-02T14:02:05.000Z');
const parse = (name: string) => parseCodexSession({ filePath: `/${name}`, text: fixture(name), now: NOW, activeWindowMs: MINUTE });
const child = parse('codex-tree-child.jsonl');
const grandchild = parse('codex-tree-grandchild.jsonl');
const orphan = mergeCodexSessions(child, [grandchild]);
const adopted = mergeCodexSessions(parse('codex-tree-root.jsonl'), [child, grandchild]);
const directories: string[] = [];
const monitors: Monitor[] = [];
let watcher: EventEmitter;

beforeEach(() => {
  useStore.setState(useStore.getInitialState(), true);
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(chokidar.watch).mockReturnValue(watcher as unknown as FSWatcher);
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
});

afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.stop();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('native trees with bounded monitor work', () => {
  it('shares a held orphan read with its adopted root refresh and redirects the open renderer tree', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentlens-tree-cache-'));
    directories.push(dir);
    const day = join(dir, 'codex', '2026', '03', '02');
    await mkdir(day, { recursive: true });
    for (const name of ['child', 'grandchild']) await writeFile(join(day, `rollout-${name}.jsonl`), fixture(`codex-tree-${name}.jsonl`));
    const settings: Settings = { claudeSessionsDir: join(dir, 'claude'), codexSessionsDir: join(dir, 'codex'), activeWindowSeconds: 45, pricing: {}, notifications: false, theme: 'system', claudeBinary: '', allowPrMerge: false };
    const monitor = new Monitor(settings);
    monitors.push(monitor);
    await monitor.start();
    const store = useStore.getState();
    store.setSnapshot(monitor.snapshot());
    store.selectRun('codex-child');
    store.setDetail(orphan);
    store.setDetailLoading(true);
    store.setDetailError('Previous refresh failed');
    monitor.watchRun('codex-child');
    monitor.on('snapshot', (snapshot) => useStore.getState().setSnapshot(snapshot));
    const emitted: RunDetail[] = [];
    monitor.on('run', (detail) => {
      emitted.push(detail);
      useStore.getState().setDetail(detail);
    });

    const original = discovery.loadRunDetail;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let started = false;
    const load = vi.spyOn(discovery, 'loadRunDetail').mockImplementationOnce(async (...args) => {
      const detail = await original(...args);
      started = true;
      await held;
      return detail;
    });
    const request = monitor.loadRun('codex-child');
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      const rootPath = join(day, 'rollout-root.jsonl');
      await writeFile(rootPath, fixture('codex-tree-root.jsonl'));
      watcher.emit('add', rootPath);
      await vi.waitFor(() => expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['codex-root']), { timeout: 3_000 });
      expect(load).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    const tokenRequest = monitor.loadRunTokens('codex-grandchild');
    expect(await request).toMatchObject({ stale: false, run: { id: 'codex-root', agentCount: 3 } });
    expect(await tokenRequest).toMatchObject({ id: 'codex-root', tokensStale: false });
    await vi.waitFor(() => expect(emitted).toHaveLength(1));
    expect(load).toHaveBeenCalledTimes(2);
    expect(useStore.getState()).toMatchObject({ selectedRunId: 'codex-root', selectedAgentId: 'codex-child', detailLoading: false, detailError: undefined });
  });

  it('pins the adopted root before cache eviction and clears only its selection state', () => {
    const store = useStore.getState();
    store.setSnapshot({ runs: [orphan.run], sources: [], scannedAt: NOW });
    store.selectRun('codex-child');
    store.setDetail(orphan);
    for (let index = 0; index < 7; index += 1) store.setDetail({ run: { ...orphan.run, id: 'other-' + index }, agents: [] });
    store.setDetailLoading(true);
    store.setDetailError('Retry needed');
    store.setSnapshot({ runs: [adopted.run], sources: [], scannedAt: NOW });
    store.setDetail(adopted);
    const state = useStore.getState();
    expect(Object.keys(state.details)).toHaveLength(8);
    expect(state.details['codex-child']).toBeUndefined();
    expect(state.details['codex-root']).toBe(adopted);
    expect(state).toMatchObject({ selectedRunId: 'codex-root', detailLoading: false, detailError: undefined });
    state.setDetailLoading(true);
    state.setDetailError('Keep selected error');
    state.setDetail({ run: { ...orphan.run, id: 'unrelated' }, agents: [] });
    expect(useStore.getState()).toMatchObject({ selectedRunId: 'codex-root', detailLoading: true, detailError: 'Keep selected error' });
    expect(useStore.getState().details['codex-root']).toBe(adopted);
  });
});
