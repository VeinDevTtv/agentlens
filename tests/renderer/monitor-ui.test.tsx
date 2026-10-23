// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../../src/renderer/App';
import { Sidebar } from '../../src/renderer/components/Sidebar';
import { useStore } from '../../src/renderer/store';
import type { RunDetail, RunSummary, Snapshot } from '../../src/shared/types';

const api = vi.hoisted(() => ({
  getSettings: vi.fn(), getSnapshot: vi.fn(), listWorkflows: vi.fn(), listChats: vi.fn(),
  getOrchestratorConfig: vi.fn(), onSnapshot: vi.fn(), onRunUpdate: vi.fn(),
  onWorkflowUpdate: vi.fn(), onChatUpdate: vi.fn(), onStatusChange: vi.fn(),
  watchRun: vi.fn(), loadRun: vi.fn(), loadRunTokens: vi.fn(), rescan: vi.fn(),
  platform: 'linux',
}));
vi.mock('../../src/renderer/lib/bridge', () => ({ bridge: () => api }));

function summary(id = 'claude:run', tokensLoaded = true): RunSummary {
  return {
    id, provider: 'claude', title: `Session ${id}`, projectName: 'project',
    projectPath: '/project', cwd: '/project', filePath: `/sessions/${id}.jsonl`,
    status: 'running', lastActivityAt: 1000, agentCount: 1, tokensLoaded, isEmpty: false,
    ...(tokensLoaded ? { tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 } } : {}),
  };
}

function detail(run: RunSummary, stale = false): RunDetail {
  return { run, agents: [], stale };
}

function snapshot(runs: RunSummary[]): Snapshot {
  return { runs, sources: [], scannedAt: 1000 };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
    observe() { this.callback([{ isIntersecting: true }]); }
    disconnect() {}
  });
  useStore.setState(useStore.getInitialState(), true);
  useStore.setState({ loading: false, view: 'timeline' });
  api.getSettings.mockResolvedValue(useStore.getState().settings);
  api.getSnapshot.mockImplementation(async () => useStore.getState().snapshot ?? snapshot([]));
  api.listWorkflows.mockResolvedValue([]);
  api.listChats.mockResolvedValue([]);
  api.getOrchestratorConfig.mockResolvedValue(undefined);
  for (const subscribe of [api.onSnapshot, api.onRunUpdate, api.onWorkflowUpdate, api.onChatUpdate, api.onStatusChange]) {
    subscribe.mockReturnValue(() => undefined);
  }
  api.watchRun.mockResolvedValue(undefined);
  api.rescan.mockResolvedValue(undefined);
  api.loadRunTokens.mockResolvedValue(undefined);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function button(label: string): HTMLButtonElement {
  const found = Array.from(container.querySelectorAll('button')).find((element) => element.textContent === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}

describe('sidebar token loading', () => {
  it('counts a visible row once and keeps stale totals without another parse on each write', async () => {
    const initial = summary('claude:run', false);
    const counted = summary();
    api.loadRunTokens.mockResolvedValue(counted);
    useStore.setState({ snapshot: snapshot([initial]) });
    await act(async () => root.render(<Sidebar />));
    expect(api.loadRunTokens).toHaveBeenCalledExactlyOnceWith(initial.id);
    expect(container.textContent).toContain('120 tok');
    for (let write = 0; write < 4; write += 1) {
      await act(async () => useStore.getState().setSnapshot(snapshot([{ ...counted, tokensStale: true, lastActivityAt: 2000 + write }])));
    }
    expect(api.loadRunTokens).toHaveBeenCalledTimes(1);
    expect(container.textContent).toContain('120 tok · stale');
    expect(container.querySelector('[aria-label="120 tokens, awaiting refresh"]')).not.toBeNull();
  });
});

describe('selected run recovery', () => {
  it('automatically retries one discovery miss and displays the loaded run', async () => {
    const run = summary();
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id });
    api.loadRun.mockResolvedValueOnce(undefined).mockResolvedValueOnce(detail(run));
    await act(async () => root.render(<App />));
    expect(api.rescan).toHaveBeenCalledOnce();
    expect(api.loadRun).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.workspace')).not.toBeNull();
    expect(container.textContent).not.toContain('Run could not be loaded');
  });

  it('shows a recoverable read error and the Retry button reloads the selected run', async () => {
    const run = summary();
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id });
    api.loadRun.mockRejectedValueOnce(new Error('Session directory cannot be read'));
    await act(async () => root.render(<App />));
    expect(container.textContent).toContain('Session directory cannot be read');
    expect(container.textContent).toContain('Check session directory');
    api.loadRun.mockResolvedValue(detail(run));
    await act(async () => button('Retry').click());
    expect(api.loadRun).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.workspace')).not.toBeNull();
    expect(useStore.getState().detailError).toBeUndefined();
  });

  it('retains existing detail during refresh and after a failed refresh', async () => {
    const run = summary();
    const previous = detail(run);
    const pending = deferred<RunDetail | undefined>();
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id, details: { [run.id]: previous } });
    api.loadRun.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(undefined);
    await act(async () => root.render(<App />));
    expect(container.querySelector('.workspace')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Refreshing this run');
    await act(async () => pending.resolve(undefined));
    expect(api.loadRun).toHaveBeenCalledTimes(2);
    expect(useStore.getState().details[run.id]).toBe(previous);
    expect(container.querySelector('.workspace')).not.toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Could not refresh this run');
    expect(button('Refresh')).toBeDefined();
  });

  it('keeps a newer live update when an older load completes afterwards', async () => {
    const run = summary();
    const pending = deferred<RunDetail | undefined>();
    let update: ((detail: RunDetail) => void) | undefined;
    api.onRunUpdate.mockImplementation((listener: (detail: RunDetail) => void) => { update = listener; return () => undefined; });
    api.loadRun.mockReturnValue(pending.promise);
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id });
    await act(async () => root.render(<App />));
    const live = detail({ ...run, lastActivityAt: 3000 });
    await act(async () => update?.(live));
    await act(async () => pending.resolve(detail({ ...run, lastActivityAt: 2000 })));
    expect(useStore.getState().details[run.id]).toBe(live);
    expect(useStore.getState().detailLoading).toBe(false);
    expect(useStore.getState().detailError).toBeUndefined();
  });

  it('does not overwrite newer discovery metadata with a stale completed parse', async () => {
    const run = summary();
    const pending = deferred<RunDetail | undefined>();
    api.loadRun.mockReturnValue(pending.promise);
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id });
    await act(async () => root.render(<App />));
    const newer = { ...run, lastActivityAt: 4000, tokensStale: true };
    await act(async () => useStore.getState().setSnapshot(snapshot([newer])));
    const completed = detail({ ...run, lastActivityAt: 3000 }, true);
    await act(async () => pending.resolve(completed));
    expect(useStore.getState().snapshot?.runs[0]).toBe(newer);
    expect(useStore.getState().details[run.id]).toBe(completed);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('snapshot may be out of date');
  });

  it('shows a refresh action when the summary becomes stale before a detail update', async () => {
    const run = summary();
    api.loadRun.mockResolvedValue(detail(run));
    useStore.setState({ snapshot: snapshot([run]), selectedRunId: run.id });
    await act(async () => root.render(<App />));
    expect(container.querySelector('.run-refresh-status')).toBeNull();
    await act(async () => useStore.getState().setSnapshot(snapshot([{ ...run, tokensStale: true }])));
    expect(useStore.getState().details[run.id]?.stale).toBe(false);
    expect(container.querySelector('[role="status"]')?.textContent).toContain('snapshot may be out of date');
    expect(button('Refresh')).toBeDefined();
  });

  it('does not let a previous selection clear the current load or replace its detail', async () => {
    const oldRun = summary('claude:old');
    const newRun = summary('claude:new');
    const oldRead = deferred<RunDetail | undefined>();
    const newRead = deferred<RunDetail | undefined>();
    api.loadRun.mockImplementation((id: string) => id === oldRun.id ? oldRead.promise : newRead.promise);
    useStore.setState({ snapshot: snapshot([oldRun, newRun]), selectedRunId: oldRun.id });
    await act(async () => root.render(<App />));
    await act(async () => useStore.getState().selectRun(newRun.id));
    await act(async () => oldRead.resolve(detail(oldRun)));
    expect(useStore.getState().selectedRunId).toBe(newRun.id);
    expect(useStore.getState().detailLoading).toBe(true);
    expect(useStore.getState().details[oldRun.id]).toBeUndefined();
    const loaded = detail(newRun);
    await act(async () => newRead.resolve(loaded));
    expect(useStore.getState().details[newRun.id]).toBe(loaded);
    expect(useStore.getState().detailLoading).toBe(false);
  });
});
