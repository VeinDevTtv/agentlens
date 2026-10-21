import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, applyEvent, createWorkflow, markInterrupted, nextPendingStep, parseStreamLine, workflowName } from '../src/core';
import type { RoleDefinition, WorkflowRun, WorkflowTemplate } from '../src/shared/types';

const roles = DEFAULT_ROLES.filter((r) => ['planner', 'coder', 'reviewer'].includes(r.id)) as RoleDefinition[];
const T0 = 1_700_000_000_000;

function seed(count = 3): WorkflowRun {
  return createWorkflow({ id: 'wf', goal: 'Add dark mode', cwd: '/home/dev/app', roles: roles.slice(0, count), sessionIds: ['s0', 's1', 's2'].slice(0, count), now: T0 });
}

describe('createWorkflow', () => {
  it('creates one pending step per role', () => {
    const wf = seed();
    expect(wf.status).toBe('running');
    expect(wf.steps).toHaveLength(3);
    expect(wf.steps.map((s) => s.sessionId)).toEqual(['s0', 's1', 's2']);
    expect(wf.steps.map((s) => s.roleId)).toEqual(['planner', 'coder', 'reviewer']);
    expect(wf.steps.every((s) => s.status === 'pending')).toBe(true);
    expect(wf.steps[0]?.prompt).toContain('Goal: Add dark mode');
    expect(wf.steps[1]?.prompt).toBe('');
    expect(wf.steps[2]?.prompt).toBe('');
    expect(wf.createdAt).toBe(T0);
    expect(wf.templateId).toBeUndefined();
  });

  it('rejects empty role lists and mismatched session ids', () => {
    expect(() => createWorkflow({ id: 'x', goal: 'g', cwd: '/home/dev', roles: [], sessionIds: [], now: T0 })).toThrow(/at least one role/);
    expect(() => createWorkflow({ id: 'x', goal: 'g', cwd: '/home/dev', roles: roles.slice(0, 2), sessionIds: ['a'], now: T0 })).toThrow(/session id/);
  });
});

describe('workflowName', () => {
  const template: WorkflowTemplate = { id: 't', name: 'Plan and build', description: '', roleIds: ['planner', 'coder'] };

  it('shortens long goals', () => {
    const name = workflowName('a'.repeat(100), undefined);
    expect(name.endsWith('…')).toBe(true);
    expect(name.length).toBeLessThanOrEqual(60);
  });

  it('prefixes the template name', () => {
    expect(workflowName('  fix   login ', template)).toBe('Plan and build: fix login');
  });
});

describe('applyEvent', () => {
  it('walks a workflow from start to finish without mutating inputs', () => {
    const initial = seed();
    const snapshot = JSON.parse(JSON.stringify(initial));

    const started = applyEvent(initial, { type: 'step-started', stepIndex: 0, at: T0 + 1 }, roles);
    expect(started.steps[0]).toMatchObject({ status: 'running', startedAt: T0 + 1 });
    expect(started.updatedAt).toBe(T0 + 1);
    expect(initial).toEqual(snapshot);

    const ignored = applyEvent(started, { type: 'step-progress', stepIndex: 1, liveText: 'nope' }, roles);
    expect(ignored).toBe(started);

    const progressed = applyEvent(started, { type: 'step-progress', stepIndex: 0, liveText: 'Reading files', currentAction: 'Read src/App.tsx' }, roles);
    expect(progressed.steps[0]).toMatchObject({ liveText: 'Reading files', currentAction: 'Read src/App.tsx' });

    const finished = applyEvent(progressed, { type: 'step-finished', stepIndex: 0, at: T0 + 2, output: 'Plan: edit theme.ts', costUsd: 0.5, turns: 4 }, roles);
    expect(finished.status).toBe('running');
    expect(finished.steps[0]).toMatchObject({ status: 'finished', endedAt: T0 + 2, output: 'Plan: edit theme.ts', costUsd: 0.5, turns: 4 });
    expect(finished.steps[0]?.liveText).toBeUndefined();
    expect(finished.steps[0]?.currentAction).toBeUndefined();
    expect(finished.steps[1]?.prompt).toContain('previous step (Planner)');
    expect(finished.steps[1]?.prompt).toContain('Plan: edit theme.ts');
    expect(finished.steps[1]?.prompt).toContain('step 2 of 3');

    const last = [1, 2].reduce((wf, index) => {
      const running = applyEvent(wf, { type: 'step-started', stepIndex: index, at: T0 + 10 + index }, roles);
      return applyEvent(running, { type: 'step-finished', stepIndex: index, at: T0 + 20 + index, output: `out ${index}` }, roles);
    }, finished);
    expect(last.status).toBe('finished');
    expect(last.steps.every((s) => s.status === 'finished')).toBe(true);
    expect(last.steps[2]?.prompt).toContain('previous step (Coder)');
  });

  it('fails the workflow and cancels remaining steps on error', () => {
    const running = applyEvent(seed(), { type: 'step-started', stepIndex: 0, at: T0 + 1 }, roles);
    const errored = applyEvent(running, { type: 'step-errored', stepIndex: 0, at: T0 + 2, error: 'boom' }, roles);
    expect(errored.status).toBe('errored');
    expect(errored.error).toBe('boom');
    expect(errored.steps[0]).toMatchObject({ status: 'errored', endedAt: T0 + 2, error: 'boom' });
    expect(errored.steps[1]?.status).toBe('cancelled');
    expect(errored.steps[2]?.status).toBe('cancelled');
  });

  it('cancels the running step and everything pending', () => {
    const running = applyEvent(seed(), { type: 'step-started', stepIndex: 0, at: T0 + 1 }, roles);
    const cancelled = applyEvent(running, { type: 'cancelled', at: T0 + 5 }, roles);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.steps[0]).toMatchObject({ status: 'cancelled', endedAt: T0 + 5 });
    expect(cancelled.steps[1]?.status).toBe('cancelled');
    expect(cancelled.steps[1]?.endedAt).toBeUndefined();
    expect(running.steps[0]?.status).toBe('running');
  });

  it('ignores events for unknown steps', () => {
    const wf = seed();
    expect(applyEvent(wf, { type: 'step-started', stepIndex: 9, at: T0 }, roles)).toBe(wf);
  });
});

describe('nextPendingStep', () => {
  it('returns the first pending step', () => {
    expect(nextPendingStep(seed())).toBe(0);
    const running = applyEvent(seed(), { type: 'step-started', stepIndex: 0, at: T0 }, roles);
    const finished = applyEvent(running, { type: 'step-finished', stepIndex: 0, at: T0, output: 'x' }, roles);
    expect(nextPendingStep(finished)).toBe(1);
  });

  it('returns undefined while a step runs or the workflow is over', () => {
    const running = applyEvent(seed(), { type: 'step-started', stepIndex: 0, at: T0 }, roles);
    expect(nextPendingStep(running)).toBeUndefined();
    expect(nextPendingStep(applyEvent(running, { type: 'cancelled', at: T0 }, roles))).toBeUndefined();
  });
});

describe('markInterrupted', () => {
  it('fails a workflow that was running when the app closed', () => {
    const first = applyEvent(applyEvent(seed(), { type: 'step-started', stepIndex: 0, at: T0 }, roles), { type: 'step-finished', stepIndex: 0, at: T0, output: 'plan' }, roles);
    const running = applyEvent(first, { type: 'step-started', stepIndex: 1, at: T0 }, roles);
    const interrupted = markInterrupted(running, T0 + 1);
    expect(interrupted.status).toBe('errored');
    expect(interrupted.error).toMatch(/closed/);
    expect(interrupted.steps[1]).toMatchObject({ status: 'errored', endedAt: T0 + 1 });
    expect(interrupted.steps[2]?.status).toBe('cancelled');
  });

  it('leaves finished workflows alone', () => {
    const finished = applyEvent(applyEvent(seed(1), { type: 'step-started', stepIndex: 0, at: T0 }, roles), { type: 'step-finished', stepIndex: 0, at: T0, output: 'done' }, roles);
    expect(markInterrupted(finished, T0 + 1)).toBe(finished);
  });
});

describe('parseStreamLine', () => {
  it('ignores blank and non-JSON lines', () => {
    expect(parseStreamLine('')).toEqual([]);
    expect(parseStreamLine('   ')).toEqual([]);
    expect(parseStreamLine('Loading…')).toEqual([]);
    expect(parseStreamLine('{not json')).toEqual([]);
  });

  it('reads the init record', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc', model: 'claude-sonnet-5-5' }))).toEqual([{ kind: 'init', sessionId: 'abc', model: 'claude-sonnet-5-5' }]);
  });

  it('turns assistant content into text and tool-call signals', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Edit', input: { file_path: 'src/App.tsx' } },
          { type: 'text', text: 'Working on it' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Grep', input: { pattern: 'TODO' } },
          { type: 'tool_use', name: 'Agent', input: { description: 'Review diff' } },
          { type: 'tool_use', name: 'TodoWrite', input: { todos: [] } },
        ],
      },
    });
    expect(parseStreamLine(line)).toEqual([
      { kind: 'assistant-text', text: 'Working on it' },
      { kind: 'tool-call', name: 'Edit', summary: 'Edit src/App.tsx' },
      { kind: 'tool-call', name: 'Bash', summary: 'Bash: npm test' },
      { kind: 'tool-call', name: 'Grep', summary: 'Grep TODO' },
      { kind: 'tool-call', name: 'Agent', summary: 'Agent: Review diff' },
      { kind: 'tool-call', name: 'TodoWrite', summary: 'TodoWrite' },
    ]);
  });

  it('reports other assistant records as other', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '…' }] } }))).toEqual([{ kind: 'other' }]);
    expect(parseStreamLine(JSON.stringify({ type: 'user', message: {} }))).toEqual([{ kind: 'other' }]);
  });

  it('reads result records', () => {
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All done', total_cost_usd: 0.42, num_turns: 7 }))).toEqual([
      { kind: 'result', isError: false, text: 'All done', costUsd: 0.42, turns: 7 },
    ]);
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Something broke' }))).toEqual([{ kind: 'result', isError: true, text: 'Something broke' }]);
    expect(parseStreamLine(JSON.stringify({ type: 'result', subtype: 'error_max_turns' }))).toEqual([{ kind: 'result', isError: true, text: 'error_max_turns' }]);
  });
});
