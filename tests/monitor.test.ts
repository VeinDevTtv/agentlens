import { EventEmitter } from 'node:events';
import { basename, join } from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/main/monitor';
import { claudeHeader, codexRunHeader, discoverAll, loadRunDetail, type DiscoveryResult, type RunLocation } from '../src/main/discovery';
import type { RunDetail, RunSummary, Settings } from '../src/shared/types';

vi.mock('chokidar', () => ({ default: { watch: vi.fn() } }));
vi.mock('../src/main/discovery', () => ({
  claudeHeader: vi.fn(),
  codexRunHeader: vi.fn(),
  discoverAll: vi.fn(),
  loadRunDetail: vi.fn(),
}));

const T0 = 1_700_000_000_000;
const settings: Settings = {
  claudeSessionsDir: join('logs', 'claude'),
  codexSessionsDir: join('logs', 'codex'),
  activeWindowSeconds: 45,
  theme: 'system',
  notifications: false,
  pricing: {},
  claudeBinary: '',
  allowPrMerge: false,
};

function location(id: string): RunLocation {
  return { id, provider: 'claude', filePath: join(settings.claudeSessionsDir, 'project', id + '.jsonl') };
}

function summary(id: string, changes: Partial<RunSummary> = {}): RunSummary {
  return {
    id, provider: 'claude', title: 'Run ' + id, projectName: 'demo', projectPath: '/demo', cwd: '/demo',
    filePath: location(id).filePath, status: 'running', agentCount: 1, tokensLoaded: false, isEmpty: false,
    lastActivityAt: T0, ...changes,
  };
}

function detail(id: string, changes: Partial<RunSummary> = {}): RunDetail {
  const run = summary(id, { tokensLoaded: true, tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, ...changes });
  return { run, agents: [{
    id, runId: id, provider: run.provider, title: run.title, role: 'main', depth: 0, status: run.status,
    tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, usageByModel: [], filesTouched: [],
    toolCallCount: 0, toolCalls: [], timeline: [], todos: [],
  }] };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let discovery: DiscoveryResult;
let watcher: EventEmitter & { close: ReturnType<typeof vi.fn> };
let monitors: Monitor[];

function seed(ids: string[]): void {
  discovery = { runs: ids.map((id) => summary(id)), locations: new Map(ids.map((id) => [id, location(id)])), sources: [] };
}

async function start(): Promise<Monitor> {
  const monitor = new Monitor(settings);
  monitors.push(monitor);
  await monitor.start();
  return monitor;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  vi.resetAllMocks();
  monitors = [];
  seed(['a', 'b']);
  watcher = Object.assign(new EventEmitter(), { close: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(chokidar.watch).mockReturnValue(watcher as unknown as FSWatcher);
  vi.mocked(discoverAll).mockImplementation(async () => ({ ...discovery, locations: new Map(discovery.locations) }));
  vi.mocked(loadRunDetail).mockImplementation(async (loc) => detail(loc.id));
  vi.mocked(claudeHeader).mockImplementation(async (path) => {
    const id = basename(path, '.jsonl');
    return { run: summary(id), location: location(id) };
  });
  vi.mocked(codexRunHeader).mockImplementation(async (loc) => {
    return { run: summary(loc.id, { provider: 'codex', filePath: loc.filePath }), location: loc };
  });
});

afterEach(() => {
  for (const monitor of monitors) monitor.stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Monitor parsing and caching', () => {
  it('shares one full parse between simultaneous detail and token requests', async () => {
    const monitor = await start();
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const requests = [monitor.loadRun('a'), monitor.loadRun('a'), monitor.loadRunTokens('a')];
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    read.resolve(detail('a'));
    await Promise.all(requests);
    await monitor.loadRun('a');
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().runs.find((r) => r.id === 'a')?.tokensLoaded).toBe(true);
  });

  it('does not turn sidebar token loads into permanent full-parse subscriptions', async () => {
    seed(Array.from({ length: 20 }, (_, i) => 'run-' + i));
    const monitor = await start();
    await Promise.all(discovery.runs.map((run) => monitor.loadRunTokens(run.id)));
    vi.mocked(loadRunDetail).mockClear();
    for (const run of discovery.runs) watcher.emit('change', run.filePath);
    await vi.advanceTimersByTimeAsync(300);
    // This used to read and parse all 20 complete runs after merely scrolling the sidebar.
    expect(loadRunDetail).not.toHaveBeenCalled();
    expect(claudeHeader).toHaveBeenCalledTimes(20);
    expect(monitor.snapshot().runs.every((run) => run.tokensLoaded && run.tokensStale)).toBe(true);
    // A visible sidebar row now keeps tokensLoaded=true, so its lazy-loading effect
    // does not re-arm; even explicit token reads reuse the labelled stale total.
    await Promise.all(discovery.runs.map((run) => monitor.loadRunTokens(run.id)));
    expect(loadRunDetail).not.toHaveBeenCalled();
  });

  it('bounds the detail cache while retaining the selected run', async () => {
    seed(Array.from({ length: 12 }, (_, i) => 'run-' + i));
    const monitor = await start();
    monitor.watchRun('run-0');
    for (const run of discovery.runs) await monitor.loadRun(run.id);
    vi.mocked(loadRunDetail).mockClear();
    await monitor.loadRun('run-0');
    await monitor.loadRun('run-11');
    expect(loadRunDetail).not.toHaveBeenCalled();
    await monitor.loadRun('run-1');
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous writes from a main agent and all of its subagents', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    await monitor.loadRun('a');
    vi.mocked(loadRunDetail).mockClear();
    const updates = vi.fn();
    monitor.on('run', updates);
    watcher.emit('change', location('a').filePath);
    for (let i = 0; i < 12; i += 1) {
      watcher.emit('change', join(settings.claudeSessionsDir, 'project', 'a', 'subagents', 'agent-' + i + '.jsonl'));
    }
    await vi.advanceTimersByTimeAsync(300);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('discovers a new Claude session when the last coalesced event is child metadata', async () => {
    const monitor = await start();
    watcher.emit('add', location('new-run').filePath);
    watcher.emit('add', join(settings.claudeSessionsDir, 'project', 'new-run', 'subagents', 'agent-1.meta.json'));
    await vi.advanceTimersByTimeAsync(300);
    expect(claudeHeader).toHaveBeenCalledExactlyOnceWith(location('new-run').filePath, settings);
    expect(monitor.snapshot().runs.some((run) => run.id === 'new-run')).toBe(true);
  });

  it('discards a parse overtaken by a log write and shares the replacement', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    const oldRead = deferred<RunDetail>();
    const newRead = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const snapshots: string[] = [];
    monitor.on('snapshot', (snapshot) => snapshots.push(snapshot.runs.find((r) => r.id === 'a')?.title ?? ''));
    const request = monitor.loadRun('a');
    watcher.emit('change', location('a').filePath);
    await vi.advanceTimersByTimeAsync(300);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    oldRead.resolve(detail('a', { title: 'stale parse' }));
    await vi.advanceTimersByTimeAsync(1);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    newRead.resolve(detail('a', { title: 'latest parse' }));
    expect((await request)?.run.title).toBe('latest parse');
    expect(snapshots).not.toContain('stale parse');
    expect(monitor.snapshot().runs.find((r) => r.id === 'a')?.title).toBe('latest parse');
  });

  it('keeps a fresh token summary if an older cheap header finishes afterward', async () => {
    const monitor = await start();
    const header = deferred<Awaited<ReturnType<typeof claudeHeader>>>();
    vi.mocked(claudeHeader).mockReturnValueOnce(header.promise);
    watcher.emit('change', location('a').filePath);
    await vi.advanceTimersByTimeAsync(300);
    await monitor.loadRunTokens('a');
    header.resolve({ run: summary('a'), location: location('a') });
    await vi.advanceTimersByTimeAsync(1);
    expect(monitor.snapshot().runs.find((r) => r.id === 'a')?.tokensLoaded).toBe(true);
  });

  it('refreshes cached statuses as wall-clock time advances', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    await monitor.loadRun('a');
    vi.mocked(loadRunDetail).mockImplementation(async (loc) => detail(loc.id, { status: 'idle' }));
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await monitor.loadRun('a'))?.run.status).toBe('idle');
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
  });

  it('continues aging idle runs to finished beyond the active window', async () => {
    discovery.runs = [summary('a', { status: 'idle', lastActivityAt: T0 - 29 * 60_000 })];
    const monitor = await start();
    vi.mocked(claudeHeader).mockResolvedValue({ run: summary('a', { status: 'finished' }), location: location('a') });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(monitor.snapshot().runs[0]?.status).toBe('finished');
  });
});

describe('Monitor lifecycle races', () => {
  it('does not publish or cache an in-flight read after stop', async () => {
    const monitor = await start();
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const snapshots = vi.fn();
    monitor.on('snapshot', snapshots);
    const request = monitor.loadRun('a');
    watcher.emit('change', location('a').filePath);
    monitor.stop();
    read.resolve(detail('a', { title: 'late' }));
    expect(await request).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    expect(snapshots).not.toHaveBeenCalled();
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
  });

  it('does not start a watcher when stopped during initial discovery', async () => {
    const scan = deferred<DiscoveryResult>();
    vi.mocked(discoverAll).mockReturnValueOnce(scan.promise);
    const monitor = new Monitor(settings);
    monitors.push(monitor);
    const starting = monitor.start();
    monitor.stop();
    scan.resolve(discovery);
    await starting;
    expect(chokidar.watch).not.toHaveBeenCalled();
    expect(monitor.snapshot().runs).toEqual([]);
  });

  it('does not repopulate a rescanned index with an older full read', async () => {
    const monitor = await start();
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const request = monitor.loadRun('a');
    seed(['b']);
    await monitor.rescan();
    read.resolve(detail('a'));
    expect(await request).toBeUndefined();
    expect(monitor.snapshot().runs.map((r) => r.id)).toEqual(['b']);
  });

  it('drops old reads and queued watcher work after a directory change', async () => {
    const monitor = await start();
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const request = monitor.loadRun('a');
    watcher.emit('change', location('a').filePath);
    seed(['b']);
    await monitor.updateSettings({ ...settings, claudeSessionsDir: join('logs', 'new-claude') });
    read.resolve(detail('a'));
    expect(await request).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    expect(monitor.snapshot().runs.map((r) => r.id)).toEqual(['b']);
    expect(claudeHeader).not.toHaveBeenCalled();
  });

  it('uses the new source index for requests arriving before the old watcher closes', async () => {
    const monitor = await start();
    const closing = deferred<void>();
    watcher.close.mockReturnValueOnce(closing.promise);
    const nextSettings = { ...settings, claudeSessionsDir: join('logs', 'new-source') };
    const nextLocation = { ...location('a'), filePath: join(nextSettings.claudeSessionsDir, 'project', 'a.jsonl') };
    discovery = { runs: [summary('a', { filePath: nextLocation.filePath })], locations: new Map([['a', nextLocation]]), sources: [] };
    vi.mocked(loadRunDetail).mockResolvedValueOnce(detail('a', { filePath: nextLocation.filePath }));
    const changing = monitor.updateSettings(nextSettings);
    const request = monitor.loadRun('a');
    expect(await request).toMatchObject({ run: { filePath: nextLocation.filePath } });
    expect(loadRunDetail).toHaveBeenCalledExactlyOnceWith(nextLocation, nextSettings, T0);
    closing.resolve(undefined);
    await changing;
  });

  it('does not wait for obsolete discovery before switching sources or accept its late index', async () => {
    const monitor = await start();
    const oldDiscovery = discovery;
    const oldScan = deferred<DiscoveryResult>();
    vi.mocked(discoverAll).mockReturnValueOnce(oldScan.promise);
    const rescanning = monitor.rescan();
    seed(['new-source-run']);
    await monitor.updateSettings({ ...settings, claudeSessionsDir: join('logs', 'new-source') });
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['new-source-run']);
    oldScan.resolve(oldDiscovery);
    await rescanning;
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['new-source-run']);
  });
});

describe('bounded reads under live writes and rescans', () => {
  it('settles after two parses despite writes throughout both reads, then allows a fresh retry', async () => {
    const monitor = await start();
    const first = deferred<RunDetail>();
    const second = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const request = monitor.loadRun('a');
    for (let i = 0; i < 5; i += 1) {
      watcher.emit('change', location('a').filePath);
      await vi.advanceTimersByTimeAsync(20);
    }
    first.resolve(detail('a', { title: 'first completed snapshot' }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i += 1) {
      watcher.emit('change', location('a').filePath);
      await vi.advanceTimersByTimeAsync(20);
    }
    second.resolve(detail('a', { title: 'latest completed snapshot' }));
    const stale = await request;
    expect(stale).toMatchObject({ stale: true, run: { title: 'latest completed snapshot', tokensStale: true } });
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    expect(await monitor.loadRunTokens('a')).toMatchObject({ tokensLoaded: true, tokensStale: true });
    expect(loadRunDetail).toHaveBeenCalledTimes(2);

    expect(await monitor.loadRun('a')).toMatchObject({ stale: false, run: { tokensStale: false } });
    expect(loadRunDetail).toHaveBeenCalledTimes(3);
  });

  it('never publishes stale terminal statuses or treats a bounded fallback as fresh cache', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    await monitor.loadRun('a');
    const statuses = vi.fn();
    monitor.on('status-change', statuses);
    const first = deferred<RunDetail>();
    const second = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    watcher.emit('change', location('a').filePath);
    const request = monitor.loadRun('a');
    watcher.emit('change', location('a').filePath);
    first.resolve(detail('a', { status: 'finished' }));
    await vi.advanceTimersByTimeAsync(0);
    watcher.emit('change', location('a').filePath);
    second.resolve(detail('a', { status: 'errored' }));
    expect((await request)?.stale).toBe(true);
    expect(statuses).not.toHaveBeenCalled();
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')?.status).toBe('running');

    vi.mocked(loadRunDetail).mockResolvedValueOnce(detail('a', { status: 'finished' }));
    expect((await monitor.loadRun('a'))?.stale).toBe(false);
    expect(statuses).toHaveBeenCalledTimes(1);
    expect(loadRunDetail).toHaveBeenCalledTimes(4);
  });

  it('retries an in-flight selection against the latest index after rescan instead of returning blank', async () => {
    const monitor = await start();
    const first = deferred<RunDetail>();
    const scan = deferred<DiscoveryResult>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(first.promise).mockResolvedValueOnce(detail('a', { title: 'after rescan' }));
    vi.mocked(discoverAll).mockReturnValueOnce(scan.promise);
    const request = monitor.loadRun('a');
    const rescanning = monitor.rescan();
    first.resolve(detail('a', { title: 'before rescan' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    scan.resolve({ ...discovery, locations: new Map(discovery.locations) });
    await rescanning;
    expect(await request).toMatchObject({ stale: false, run: { title: 'after rescan' } });
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
  });

  it('returns the latest completed snapshot when a rescan overtakes both bounded attempts', async () => {
    const monitor = await start();
    const first = deferred<RunDetail>();
    const second = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const request = monitor.loadRun('a');
    await monitor.rescan();
    first.resolve(detail('a', { title: 'first snapshot' }));
    await vi.advanceTimersByTimeAsync(0);
    await monitor.rescan();
    second.resolve(detail('a', { title: 'second snapshot' }));
    expect(await request).toMatchObject({ stale: true, run: { title: 'second snapshot' } });
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
  });

  it('retains previously counted totals as stale after rescan instead of re-arming sidebar loads', async () => {
    const monitor = await start();
    await monitor.loadRunTokens('a');
    await monitor.rescan();
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')).toMatchObject({ tokensLoaded: true, tokensStale: true });
    await monitor.loadRunTokens('a');
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
  });

  it('refreshes the selected finished transcript after a manual rescan without waiting for a status tick', async () => {
    discovery.runs = [summary('a', { status: 'finished' })];
    const monitor = await start();
    monitor.watchRun('a');
    vi.mocked(loadRunDetail).mockResolvedValueOnce(detail('a', { status: 'finished' }));
    await monitor.loadRun('a');
    vi.mocked(loadRunDetail).mockResolvedValueOnce(detail('a', { status: 'finished', title: 'after rescan' }));
    const updates = vi.fn();
    monitor.on('run', updates);
    await monitor.rescan();
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    expect(updates).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ stale: false, run: expect.objectContaining({ title: 'after rescan' }) }));
  });

  it('cleans up rejected singleflight reads so a user retry can succeed', async () => {
    const monitor = await start();
    vi.mocked(loadRunDetail).mockRejectedValueOnce(new Error('Temporary read failure'));
    await expect(monitor.loadRun('a')).rejects.toThrow('Temporary read failure');
    expect(await monitor.loadRun('a')).toMatchObject({ stale: false, run: { id: 'a' } });
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
  });

  it('recovers the eager refresh path after a rejected read', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(loadRunDetail).mockRejectedValueOnce(new Error('Temporary read failure'));
    watcher.emit('change', location('a').filePath);
    await vi.advanceTimersByTimeAsync(300);
    const updates = vi.fn();
    monitor.on('run', updates);
    watcher.emit('change', location('a').filePath);
    await vi.advanceTimersByTimeAsync(300);
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('flushes continuous writes within the one-second debounce limit', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    for (let i = 0; i < 10; i += 1) {
      watcher.emit('change', location('a').filePath);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')?.tokensLoaded).toBe(true);
  });

  it('keeps a new-source read independent from a cancelled old-source read with the same run id', async () => {
    const monitor = await start();
    const oldRead = deferred<RunDetail>();
    const newRead = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(oldRead.promise).mockReturnValueOnce(newRead.promise);
    const oldRequest = monitor.loadRun('a');
    await monitor.updateSettings({ ...settings, claudeSessionsDir: join('logs', 'another-account') });
    const newRequest = monitor.loadRun('a');
    oldRead.resolve(detail('a', { title: 'old source' }));
    expect(await oldRequest).toBeUndefined();
    newRead.resolve(detail('a', { title: 'new source' }));
    expect(await newRequest).toMatchObject({ stale: false, run: { title: 'new source' } });
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')?.title).toBe('new source');
    expect(loadRunDetail).toHaveBeenCalledTimes(2);
  });
});

describe('Monitor file deletion', () => {
  it('removes a Claude root and prevents an in-flight read from resurrecting it', async () => {
    const monitor = await start();
    monitor.watchRun('a');
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const request = monitor.loadRun('a');
    watcher.emit('change', location('a').filePath);
    watcher.emit('unlink', location('a').filePath);
    read.resolve(detail('a'));
    expect(await request).toBeUndefined();
    await vi.advanceTimersByTimeAsync(300);
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['b']);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
  });

  it.each(['agent-child.jsonl', 'agent-child.meta.json'])('refreshes the selected parent after deleting %s', async (name) => {
    const monitor = await start();
    monitor.watchRun('a');
    await monitor.loadRun('a');
    vi.mocked(loadRunDetail).mockClear().mockResolvedValueOnce(detail('a', { title: 'after child removal', agentCount: 1 }));
    const updates = vi.fn();
    monitor.on('run', updates);
    watcher.emit('unlink', join(settings.claudeSessionsDir, 'project', 'a', 'subagents', name));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRunDetail).toHaveBeenCalledTimes(1);
    expect(vi.mocked(loadRunDetail).mock.calls[0]?.[0].id).toBe('a');
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')?.title).toBe('after child removal');
    expect(updates).toHaveBeenCalledTimes(1);
  });

  it('refreshes an unwatched parent cheaply after deleting a child', async () => {
    const monitor = await start();
    await monitor.loadRunTokens('a');
    vi.mocked(loadRunDetail).mockClear();
    vi.mocked(claudeHeader).mockResolvedValueOnce({ run: summary('a', { agentCount: 2 }), location: location('a') });
    watcher.emit('unlink', join(settings.claudeSessionsDir, 'project', 'a', 'subagents', 'agent-child.jsonl'));
    await vi.advanceTimersByTimeAsync(0);
    expect(loadRunDetail).not.toHaveBeenCalled();
    expect(claudeHeader).toHaveBeenCalledExactlyOnceWith(location('a').filePath, settings);
    expect(monitor.snapshot().runs.find((run) => run.id === 'a')).toMatchObject({ agentCount: 2, tokensLoaded: true, tokensStale: true });
  });

  it('removes a Codex rollout by native id and drops its late read', async () => {
    const loc: RunLocation = { id: 'codex-native-id', provider: 'codex', filePath: join(settings.codexSessionsDir, '2026', '10', '22', 'rollout-native.jsonl') };
    discovery = { runs: [summary(loc.id, { provider: 'codex', filePath: loc.filePath })], locations: new Map([[loc.id, loc]]), sources: [] };
    const monitor = await start();
    const read = deferred<RunDetail>();
    vi.mocked(loadRunDetail).mockReturnValueOnce(read.promise);
    const request = monitor.loadRun(loc.id);
    discovery = { runs: [], locations: new Map(), sources: [] };
    watcher.emit('unlink', loc.filePath);
    read.resolve(detail(loc.id, { provider: 'codex', filePath: loc.filePath }));
    expect(await request).toBeUndefined();
    expect(monitor.snapshot().runs).toEqual([]);
    expect(await monitor.loadRun(loc.id)).toBeUndefined();
  });

  it('applies a root deletion queued during discovery after the new index arrives', async () => {
    const monitor = await start();
    const scan = deferred<DiscoveryResult>();
    vi.mocked(discoverAll).mockReturnValueOnce(scan.promise);
    const rescanning = monitor.rescan();
    watcher.emit('unlink', location('a').filePath);
    scan.resolve(discovery);
    await rescanning;
    await vi.advanceTimersByTimeAsync(0);
    expect(monitor.snapshot().runs.map((run) => run.id)).toEqual(['b']);
  });
});
