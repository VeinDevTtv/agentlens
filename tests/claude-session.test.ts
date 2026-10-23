import { describe, expect, it, vi } from 'vitest';
import { parseClaudeHeader, parseClaudeSession, parseSubagentMeta } from '../src/core';
import * as status from '../src/core/status';
import { fixture, MINUTE } from './helpers';

const MAIN_LAST = Date.parse('2026-01-15T10:00:41.000Z');

function parseMain(now: number, withSub = true) {
  return parseClaudeSession({
    sessionId: 'sess-main-1',
    filePath: '/sessions/sess-main-1.jsonl',
    mainText: fixture('claude-main.jsonl'),
    subagentFiles: withSub
      ? [{ agentId: 'abc123def4567890a', text: fixture('claude-sub-abc123def4567890a.jsonl'), meta: parseSubagentMeta(fixture('claude-sub-abc123def4567890a.meta.json')) }]
      : [],
    now,
    activeWindowMs: MINUTE,
  });
}

describe('parseClaudeSession', () => {
  it('names the run after the first user prompt and derives the project from cwd', () => {
    const { run } = parseMain(MAIN_LAST + 5_000);
    expect(run.title).toBe('Fix the login redirect loop and add tests for the auth…');
    expect(run.projectName).toBe('web');
    expect(run.cwd).toBe('/home/dev/projects/acme-shop/web');
    expect(run.gitBranch).toBe('feature/auth');
    expect(run.model).toBe('claude-opus-5-5');
    expect(run.agentCount).toBe(2);
  });

  it('uses the git root for the project name when a probe is supplied', () => {
    const result = parseClaudeSession({
      sessionId: 'sess-main-1',
      filePath: '/x.jsonl',
      mainText: fixture('claude-main.jsonl'),
      now: MAIN_LAST,
      activeWindowMs: MINUTE,
      isGitRoot: (dir) => dir === '/home/dev/projects/acme-shop',
    });
    expect(result.run.projectName).toBe('acme-shop');
    expect(result.run.projectPath).toBe('/home/dev/projects/acme-shop');
  });

  it('describes the main agent with a goal, a Now line, and a human current action', () => {
    const { agents } = parseMain(MAIN_LAST + 5_000);
    const main = agents.find((a) => a.role === 'main');
    expect(main).toBeDefined();
    expect(main?.title).toMatch(/^Fix the login redirect loop/);
    expect(main?.nowTodo).toBe('Patching auth middleware');
    expect(main?.currentAction).toBe('Run the auth middleware tests');
    expect(main?.toolCallCount).toBe(5);
    expect(main?.filesTouched).toEqual(['src/middleware/auth.ts']);
    expect(main?.todos).toHaveLength(3);
  });

  it('extracts subagent task title and prompt from the parent Agent call and meta file', () => {
    const { agents } = parseMain(MAIN_LAST + 5_000);
    const sub = agents.find((a) => a.role === 'subagent');
    expect(sub?.id).toBe('abc123def4567890a');
    expect(sub?.title).toBe('Audit auth middleware tests');
    expect(sub?.prompt).toMatch(/^Find every test that touches the auth middleware/);
    expect(sub?.subtitle?.length).toBeLessThanOrEqual(121);
    expect(sub?.agentType).toBe('Explore');
    expect(sub?.parentId).toBe('sess-main-1');
    expect(sub?.spawnToolUseId).toBe('toolu_agent1');
    expect(sub?.model).toBe('claude-sonnet-5-5');
    expect(sub?.depth).toBe(1);
    expect(sub?.currentAction).toBe("Searching for 'auth middleware'");
  });

  it('marks a subagent finished once its last turn ended, even for async launches', () => {
    const { agents } = parseMain(MAIN_LAST + 5_000);
    const sub = agents.find((a) => a.role === 'subagent');
    expect(sub?.status).toBe('finished');
    expect(sub?.endedAt).toBe(Date.parse('2026-01-15T10:00:28.000Z'));
  });

  it('reports the main agent as running while its latest tool call is recent', () => {
    const { run, agents } = parseMain(MAIN_LAST + 5_000);
    const main = agents.find((a) => a.role === 'main');
    expect(main?.status).toBe('running');
    expect(run.status).toBe('running');
  });

  it('reports a stale pending tool call as idle, and an old session as finished', () => {
    expect(parseMain(MAIN_LAST + 10 * MINUTE).agents.find((a) => a.role === 'main')?.status).toBe('idle');
    const old = parseMain(MAIN_LAST + 24 * 60 * MINUTE);
    expect(old.agents.find((a) => a.role === 'main')?.status).toBe('finished');
    expect(old.run.status).toBe('finished');
  });

  it('sums token usage once per API message and keeps a per-model breakdown', () => {
    const { run, agents } = parseMain(MAIN_LAST);
    const main = agents.find((a) => a.role === 'main');
    expect(main?.tokens).toEqual({ input: 145, output: 650, cacheRead: 7100, cacheWrite: 1000 });
    const sub = agents.find((a) => a.role === 'subagent');
    expect(sub?.tokens).toEqual({ input: 60, output: 150, cacheRead: 250, cacheWrite: 200 });
    expect(run.tokens).toEqual({ input: 205, output: 800, cacheRead: 7350, cacheWrite: 1200 });
    expect(main?.usageByModel.map((m) => m.model)).toEqual(['claude-opus-5-5']);
    expect(run.tokensLoaded).toBe(true);
  });

  it('builds a timeline with spawn, tool call, and tool result events', () => {
    const { agents } = parseMain(MAIN_LAST);
    const main = agents.find((a) => a.role === 'main');
    const kinds = main?.timeline.map((e) => e.kind);
    expect(kinds).toContain('user');
    expect(kinds).toContain('spawn');
    expect(kinds).toContain('tool-call');
    expect(kinds).toContain('tool-result');
    expect(main?.timeline.find((e) => e.kind === 'spawn')?.text).toBe('Audit auth middleware tests');
  });

  it('supports legacy in-file sidechains and matches them to the Task call by prompt', () => {
    const last = Date.parse('2026-01-10T09:00:15.000Z');
    const { run, agents } = parseClaudeSession({
      sessionId: 'sess-legacy',
      filePath: '/legacy.jsonl',
      mainText: fixture('claude-legacy-sidechain.jsonl'),
      now: last + 5 * MINUTE,
      activeWindowMs: MINUTE,
    });
    expect(run.title).toBe('Widget to Panel rename');
    expect(run.projectName).toBe('legacy-app');
    expect(agents).toHaveLength(2);
    const sub = agents.find((a) => a.role === 'subagent');
    expect(sub?.title).toBe('Find Widget usages');
    expect(sub?.agentType).toBe('general-purpose');
    expect(sub?.parentId).toBe('sess-legacy');
    expect(sub?.status).toBe('finished');
    expect(sub?.model).toBe('claude-haiku-4-5');
    const main = agents.find((a) => a.role === 'main');
    expect(main?.status).toBe('idle');
  });

  it('labels scheduled job sessions and surfaces API errors', () => {
    const { run, agents } = parseClaudeSession({
      sessionId: 'sess-job',
      filePath: '/job.jsonl',
      mainText: fixture('claude-job-tmp.jsonl'),
      now: Date.parse('2026-02-01T06:00:20.000Z'),
      activeWindowMs: MINUTE,
    });
    expect(run.projectName).toBe('Claude scheduled jobs');
    expect(run.title).toBe('Check the nightly build status and summarize failures.');
    expect(run.status).toBe('errored');
    expect(agents[0]?.error).toContain('529');
  });

  it('ignores interruption notices when titling and flags sessions with no assistant turn', () => {
    const text = [
      '{"type":"user","uuid":"e1","parentUuid":null,"isSidechain":false,"cwd":"/home/dev/x","sessionId":"sess-empty","timestamp":"2026-02-01T06:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":""}]}}',
      '{"type":"user","uuid":"e2","parentUuid":"e1","isSidechain":false,"cwd":"/home/dev/x","sessionId":"sess-empty","timestamp":"2026-02-01T06:00:01.000Z","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}',
    ].join('\n');
    const { run } = parseClaudeSession({ sessionId: 'sess-empty', filePath: '/e', mainText: text, now: Date.parse('2026-02-01T07:00:00.000Z'), activeWindowMs: MINUTE });
    expect(run.title).toBe('Empty session');
    expect(run.isEmpty).toBe(true);
    expect(parseMain(MAIN_LAST).run.isEmpty).toBe(false);
  });

  it('tolerates a truncated trailing line from a file still being written', () => {
    const text = fixture('claude-main.jsonl') + '\n{"type":"assistant","uuid":"partial","message":{"role":"assis';
    const { agents } = parseClaudeSession({ sessionId: 'sess-main-1', filePath: '/x', mainText: text, now: MAIN_LAST, activeWindowMs: MINUTE });
    expect(agents.find((a) => a.role === 'main')?.toolCallCount).toBe(5);
  });
});

describe('parseClaudeHeader', () => {
  it('reads API errors from the head when a small file has no tail chunk', () => {
    const at = Date.parse('2026-02-01T06:00:20.000Z');
    const run = parseClaudeHeader({ sessionId: 'sess-job', filePath: '/job.jsonl', headText: fixture('claude-job-tmp.jsonl'), tailText: '', mtimeMs: at, subagentCount: 0, now: at, activeWindowMs: MINUTE });
    expect(run.status).toBe('errored');
  });

  it('derives the last activity and pending tool state from an entire head chunk', () => {
    const at = Date.parse('2026-03-02T14:00:10.000Z');
    const headText = JSON.stringify({ type: 'assistant', timestamp: '2026-03-02T14:00:10.000Z', message: { role: 'assistant', model: 'claude-test', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/demo/a.ts' } }] } });
    const input = { sessionId: 'small', filePath: '/small.jsonl', headText, tailText: '', mtimeMs: at - MINUTE, subagentCount: 0, now: at, activeWindowMs: MINUTE };
    const derive = vi.spyOn(status, 'deriveStatus');
    try {
      const pending = parseClaudeHeader(input);
      expect(pending.lastActivityAt).toBe(at);
      expect(pending.status).toBe('running');
      expect(derive).toHaveBeenLastCalledWith(expect.objectContaining({ lastActivityAt: at, pendingToolCall: true }));
      const result = JSON.stringify({ type: 'user', timestamp: '2026-03-02T14:00:11.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'read', content: 'file contents' }] } });
      expect(parseClaudeHeader({ ...input, headText: `${headText}\n${result}` }).lastActivityAt).toBe(at + 1000);
      expect(derive).toHaveBeenLastCalledWith(expect.objectContaining({ lastActivityAt: at + 1000, pendingToolCall: false }));
    } finally {
      derive.mockRestore();
    }
  });

  it('produces a listing entry without parsing the whole file', () => {
    const text = fixture('claude-main.jsonl');
    const run = parseClaudeHeader({
      sessionId: 'sess-main-1',
      filePath: '/sessions/sess-main-1.jsonl',
      headText: text.slice(0, 1500),
      tailText: text.slice(-1200),
      mtimeMs: MAIN_LAST,
      subagentCount: 1,
      now: MAIN_LAST + 1000,
      activeWindowMs: MINUTE,
    });
    expect(run.title).toMatch(/^Fix the login redirect loop/);
    expect(run.projectName).toBe('web');
    expect(run.agentCount).toBe(2);
    expect(run.tokensLoaded).toBe(false);
    expect(run.tokens).toBeUndefined();
    expect(run.status).toBe('running');
    expect(run.model).toBe('claude-opus-5-5');
    expect(run.startedAt).toBe(Date.parse('2026-01-15T10:00:00.000Z'));
  });

  it('prefers the ai-title record when it appears in the tail', () => {
    const text = fixture('claude-legacy-sidechain.jsonl');
    const run = parseClaudeHeader({
      sessionId: 'sess-legacy',
      filePath: '/legacy.jsonl',
      headText: text.slice(0, 600),
      tailText: text.slice(-400),
      mtimeMs: Date.parse('2026-01-10T09:00:15.000Z'),
      subagentCount: 0,
      now: Date.parse('2026-01-10T12:00:00.000Z'),
      activeWindowMs: MINUTE,
    });
    expect(run.title).toBe('Widget to Panel rename');
    expect(run.status).toBe('finished');
  });
});
