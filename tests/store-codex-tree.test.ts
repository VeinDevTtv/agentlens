import { beforeEach, describe, expect, it } from 'vitest';
import { mergeCodexSessions, parseCodexSession } from '../src/core';
import { useStore } from '../src/renderer/store';
import { fixture, MINUTE } from './helpers';

const now = Date.parse('2026-03-02T14:02:05.000Z');
const parse = (name: string) => parseCodexSession({ filePath: `/${name}`, text: fixture(name), now, activeWindowMs: MINUTE });
const root = parse('codex-tree-root.jsonl');
const child = parse('codex-tree-child.jsonl');
const grandchild = parse('codex-tree-grandchild.jsonl');
const orphan = mergeCodexSessions(child, [grandchild]);
const adopted = mergeCodexSessions(root, [child, grandchild]);

beforeEach(() => useStore.setState(useStore.getInitialState(), true));

function selectOrphan(agentId?: string) {
  const store = useStore.getState();
  store.setSnapshot({ runs: [orphan.run], sources: [], scannedAt: now });
  store.selectRun(orphan.run.id);
  store.setDetail(orphan);
  if (agentId) store.selectAgent(agentId);
  // Discovery removes the former orphan row before the root detail arrives.
  store.setSnapshot({ runs: [adopted.run], sources: [], scannedAt: now });
}

describe('Codex orphan adoption in renderer state', () => {
  it('moves the selected orphan to its new root and selects the former main agent', () => {
    selectOrphan();
    useStore.getState().setDetail(adopted);
    const state = useStore.getState();
    expect(state.selectedRunId).toBe('codex-root');
    expect(state.selectedAgentId).toBe('codex-child');
    expect(state.snapshot?.runs.some((run) => run.id === state.selectedRunId)).toBe(true);
    expect(state.details[state.selectedRunId ?? '']).toBe(adopted);
  });

  it('keeps an explicitly selected nested agent when it remains in the adopted tree', () => {
    selectOrphan('codex-grandchild');
    useStore.getState().setDetail(adopted);
    expect(useStore.getState()).toMatchObject({ selectedRunId: 'codex-root', selectedAgentId: 'codex-grandchild' });
  });

  it('selects the former orphan when its previously selected descendant disappeared', () => {
    selectOrphan('codex-grandchild');
    useStore.getState().setDetail(mergeCodexSessions(root, [child]));
    expect(useStore.getState()).toMatchObject({ selectedRunId: 'codex-root', selectedAgentId: 'codex-child' });
  });

  it('does not redirect another selection or a Claude run with a colliding id', () => {
    const store = useStore.getState();
    store.selectRun('unrelated');
    store.selectAgent('unrelated-agent');
    store.setDetail(adopted);
    expect(useStore.getState()).toMatchObject({ selectedRunId: 'unrelated', selectedAgentId: 'unrelated-agent' });
    store.selectRun('codex-child');
    store.setSnapshot({ runs: [{ ...orphan.run, provider: 'claude' }], sources: [], scannedAt: now });
    store.setDetail(adopted);
    expect(useStore.getState().selectedRunId).toBe('codex-child');
  });
});
