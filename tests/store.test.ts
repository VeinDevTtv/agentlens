import { beforeEach, describe, expect, it } from 'vitest';
import { useStore } from '../src/renderer/store';
import type { RunDetail } from '../src/shared/types';

function detail(id: string): RunDetail {
  return {
    run: {
      id, provider: 'claude', title: id, projectName: 'demo', projectPath: '/demo', cwd: '/demo',
      filePath: '/logs/' + id + '.jsonl', status: 'idle', agentCount: 1, tokensLoaded: true, isEmpty: false,
    },
    agents: [],
  };
}

beforeEach(() => useStore.setState(useStore.getInitialState(), true));

describe('renderer detail retention', () => {
  it('bounds retained run details and preserves the selected run', () => {
    const store = useStore.getState();
    store.selectRun('run-0');
    for (let i = 0; i < 20; i += 1) store.setDetail(detail('run-' + i));
    const cached = useStore.getState().details;
    expect(Object.keys(cached)).toHaveLength(8);
    expect(cached['run-0']).toBeDefined();
    expect(cached['run-19']).toBeDefined();
    expect(cached['run-1']).toBeUndefined();
  });

  it('refreshes cache order without mutating a previous state snapshot', () => {
    const store = useStore.getState();
    for (let i = 0; i < 8; i += 1) store.setDetail(detail('run-' + i));
    const previous = useStore.getState().details;
    const refreshed = detail('run-0');
    store.setDetail(refreshed);
    store.setDetail(detail('run-8'));
    const cached = useStore.getState().details;
    expect(Object.keys(cached)).toHaveLength(8);
    expect(cached['run-0']).toBe(refreshed);
    expect(cached['run-1']).toBeUndefined();
    expect(previous['run-1']).toBeDefined();
    expect(previous['run-8']).toBeUndefined();
  });

  it('keeps the selected loading and error state when a different run updates', () => {
    const store = useStore.getState();
    store.selectRun('selected');
    store.setDetailLoading(true);
    store.setDetailError('Previous refresh failed');
    store.setDetail(detail('background'));
    expect(useStore.getState()).toMatchObject({ detailLoading: true, detailError: 'Previous refresh failed' });
    store.setDetail(detail('selected'));
    expect(useStore.getState()).toMatchObject({ detailLoading: false, detailError: undefined });
  });

  it('supports explicit retry and clears errors when switching context', () => {
    const store = useStore.getState();
    store.selectRun('selected');
    store.setDetailError('Read failed');
    store.retrySelectedRun();
    expect(useStore.getState()).toMatchObject({ detailRequestVersion: 1, detailError: undefined });
    store.retrySelectedRun();
    expect(useStore.getState().detailRequestVersion).toBe(2);
    for (const select of [() => store.selectRun('another'), () => store.selectWorkflow('workflow'), () => store.selectChat('chat')]) {
      store.setDetailError('Read failed');
      select();
      expect(useStore.getState().detailError).toBeUndefined();
    }
  });
});
