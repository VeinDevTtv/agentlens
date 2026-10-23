import { describe, expect, it, vi } from 'vitest';
import { loadSelectedRun, preferLiveDetail } from '../src/renderer/lib/load-selected-run';
import type { RunDetail } from '../src/shared/types';

function detail(lastActivityAt = 1, stale = false): RunDetail {
  return {
    run: {
      id: 'claude:run', provider: 'claude', title: 'Run', projectName: 'project',
      projectPath: '/project', cwd: '/project', filePath: '/sessions/run.jsonl',
      lastActivityAt, status: 'running', agentCount: 1, tokensLoaded: true, isEmpty: false,
    },
    agents: [],
    stale,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('selected run loading', () => {
  it('returns available detail without an unnecessary rescan', async () => {
    const loaded = detail();
    const api = { loadRun: vi.fn().mockResolvedValue(loaded), rescan: vi.fn() };
    expect(await loadSelectedRun(api, loaded.run.id, () => true)).toBe(loaded);
    expect(api.loadRun).toHaveBeenCalledExactlyOnceWith(loaded.run.id);
    expect(api.rescan).not.toHaveBeenCalled();
  });

  it('waits for a rescan before retrying a transient miss once', async () => {
    const scan = deferred<void>();
    const loaded = detail();
    const api = { loadRun: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce(loaded), rescan: vi.fn(() => scan.promise) };
    const request = loadSelectedRun(api, loaded.run.id, () => true);
    await vi.waitFor(() => expect(api.rescan).toHaveBeenCalledOnce());
    expect(api.loadRun).toHaveBeenCalledTimes(1);
    scan.resolve();
    expect(await request).toBe(loaded);
    expect(api.loadRun).toHaveBeenCalledTimes(2);
  });

  it('stops after the second miss even if the session remains unavailable', async () => {
    const api = { loadRun: vi.fn().mockResolvedValue(undefined), rescan: vi.fn().mockResolvedValue(undefined) };
    expect(await loadSelectedRun(api, 'missing', () => true)).toBeUndefined();
    expect(api.loadRun).toHaveBeenCalledTimes(2);
    expect(api.rescan).toHaveBeenCalledOnce();
  });

  it('does not start a request after the selection has changed', async () => {
    const api = { loadRun: vi.fn(), rescan: vi.fn() };
    expect(await loadSelectedRun(api, 'old', () => false)).toBeUndefined();
    expect(api.loadRun).not.toHaveBeenCalled();
    expect(api.rescan).not.toHaveBeenCalled();
  });

  it('does not rescan for a previous selection after its load finishes', async () => {
    const read = deferred<RunDetail | undefined>();
    let selected = true;
    const api = { loadRun: vi.fn(() => read.promise), rescan: vi.fn() };
    const request = loadSelectedRun(api, 'old', () => selected);
    selected = false;
    read.resolve(undefined);
    expect(await request).toBeUndefined();
    expect(api.rescan).not.toHaveBeenCalled();
  });

  it('does not issue a second load after the selection changes during rescan', async () => {
    const scan = deferred<void>();
    let selected = true;
    const api = { loadRun: vi.fn().mockResolvedValue(undefined), rescan: vi.fn(() => scan.promise) };
    const request = loadSelectedRun(api, 'old', () => selected);
    await vi.waitFor(() => expect(api.rescan).toHaveBeenCalledOnce());
    selected = false;
    scan.resolve();
    expect(await request).toBeUndefined();
    expect(api.loadRun).toHaveBeenCalledTimes(1);
  });

  it('preserves read and rescan errors for the recovery UI', async () => {
    const readError = new Error('Session directory cannot be read');
    const api = { loadRun: vi.fn().mockRejectedValue(readError), rescan: vi.fn() };
    await expect(loadSelectedRun(api, 'run', () => true)).rejects.toBe(readError);
    expect(api.rescan).not.toHaveBeenCalled();
    const scanError = new Error('Rescan failed');
    api.loadRun.mockResolvedValue(undefined);
    api.rescan.mockRejectedValue(scanError);
    await expect(loadSelectedRun(api, 'run', () => true)).rejects.toBe(scanError);
    expect(api.loadRun).toHaveBeenCalledTimes(2);
  });
});

describe('live detail ordering', () => {
  it('allows a loaded result to replace the detail present when loading started', () => {
    const before = detail();
    expect(preferLiveDetail(before, before, detail(2))).toBe(false);
    expect(preferLiveDetail(undefined, undefined, detail())).toBe(false);
  });

  it('retains a live update when an older request misses or returns older activity', () => {
    const before = detail(1);
    const live = detail(3);
    expect(preferLiveDetail(live, before, undefined)).toBe(true);
    expect(preferLiveDetail(live, before, detail(2))).toBe(true);
  });

  it('uses newer activity before freshness flags when replies race', () => {
    expect(preferLiveDetail(detail(2), detail(1), detail(3, true))).toBe(false);
    expect(preferLiveDetail(detail(3, true), detail(1), detail(2))).toBe(true);
  });

  it('prefers fresh detail when activity timestamps tie', () => {
    expect(preferLiveDetail(detail(2, true), detail(1), detail(2))).toBe(false);
    expect(preferLiveDetail(detail(2), detail(1), detail(2, true))).toBe(true);
    expect(preferLiveDetail(detail(2), detail(1), detail(2))).toBe(true);
  });
});
