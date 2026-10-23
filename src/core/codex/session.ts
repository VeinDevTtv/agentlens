import type { AgentDetail, RunDetail, RunSummary, TimelineEvent, TodoItem, ToolCall } from '../../shared/types';
import { describeToolCall } from '../activity';
import { resolveProject } from '../project';
import { deriveStatus } from '../status';
import { cleanUserText, titleFromPrompt, truncate } from '../text';
import { addUsage, EMPTY_USAGE, UsageAccumulator } from '../tokens';

interface CodexLine {
  timestamp?: string;
  type?: string;
  payload?: Record<string, unknown>;
}

export interface CodexSessionInput {
  filePath: string;
  text: string;
  mtimeMs?: number;
  now: number;
  activeWindowMs: number;
  isGitRoot?: (dir: string) => boolean;
  /** Only read enough for a listing; skips per-call detail. */
  headerOnly?: boolean;
  homeDir?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function parseLines(text: string): CodexLine[] {
  const out: CodexLine[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (isObject(value)) out.push(value as CodexLine);
    } catch {
      // partial line
    }
  }
  return out;
}

function ms(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const value = Date.parse(ts);
  return Number.isNaN(value) ? undefined : value;
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return { command: raw };
  }
}

/** Find a parent id in current `source` or a legacy `thread_source` object. */
function parentThreadOf(source: unknown): string | undefined {
  if (!isObject(source)) return undefined;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'parent_thread_id' && typeof value === 'string') return value;
    const nested = parentThreadOf(value);
    if (nested) return nested;
  }
  return undefined;
}

export interface CodexSpawn {
  callId: string;
  agentId?: string;
  prompt?: string;
  agentType?: string;
}

export interface CodexParseResult extends RunDetail {
  /** Set when this rollout is itself a subagent of another thread. */
  parentThreadId?: string;
  /** Parent tool calls supply the task even when the child forked its transcript. */
  spawns: CodexSpawn[];
}

/** Parse a Codex rollout JSONL file into a single-agent run (plus parent linkage when present). */
export function parseCodexSession(input: CodexSessionInput): CodexParseResult {
  const lines = parseLines(input.text);
  const usage = new UsageAccumulator();
  const toolCalls: ToolCall[] = [];
  const byCallId = new Map<string, ToolCall>();
  const spawns = new Map<string, CodexSpawn>();
  const timeline: TimelineEvent[] = [];
  const files = new Set<string>();
  let todos: TodoItem[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let repositoryUrl: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let firstUserText = '';
  let lastAssistantText: string | undefined;
  let startedAt: number | undefined;
  let lastActivityAt: number | undefined;
  let parentThreadId: string | undefined;
  let agentType: string | undefined;
  let turnOpen = false;
  let turnCompleted = false;
  let lastError: string | undefined;
  let cumulativeUsage: { input: number; output: number; cacheRead: number; cacheWrite: number } | undefined;

  const touch = (at: number | undefined) => {
    if (at === undefined) return;
    if (startedAt === undefined || at < startedAt) startedAt = at;
    if (lastActivityAt === undefined || at > lastActivityAt) lastActivityAt = at;
  };

  for (const line of lines) {
    const payload = line.payload ?? {};
    const at = ms(line.timestamp);
    switch (line.type) {
      case 'session_meta': {
        if (typeof payload.id === 'string' && payload.id) sessionId = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (isObject(payload.git)) {
          if (typeof payload.git.repository_url === 'string') repositoryUrl = payload.git.repository_url;
          if (typeof payload.git.branch === 'string') gitBranch = payload.git.branch;
        }
        parentThreadId = typeof payload.parent_thread_id === 'string' && payload.parent_thread_id ? payload.parent_thread_id : parentThreadOf(payload.source) ?? parentThreadOf(payload.thread_source);
        const source = isObject(payload.source) ? payload.source : undefined;
        const subagent = isObject(source?.subagent) ? source.subagent : undefined;
        const spawn = isObject(subagent?.thread_spawn) ? subagent.thread_spawn : undefined;
        agentType = [payload.agent_role, payload.agent_type, spawn?.agent_role, spawn?.agent_type].find((value): value is string => typeof value === 'string');
        touch(ms(typeof payload.timestamp === 'string' ? payload.timestamp : undefined) ?? at);
        break;
      }
      case 'turn_context': {
        if (typeof payload.model === 'string') model = payload.model;
        if (typeof payload.cwd === 'string' && !cwd) cwd = payload.cwd;
        break;
      }
      case 'event_msg': {
        const kind = payload.type;
        if (kind === 'user_message' && typeof payload.message === 'string') {
          touch(at);
          const text = cleanUserText(payload.message);
          if (text && !firstUserText) firstUserText = text;
          if (text && at !== undefined) timeline.push({ at, kind: 'user', text: truncate(text, 140) });
          lastError = undefined;
          turnCompleted = false;
        } else if (kind === 'agent_message' && typeof payload.message === 'string') {
          touch(at);
          lastAssistantText = payload.message;
          if (at !== undefined) timeline.push({ at, kind: 'assistant', text: truncate(payload.message, 140) });
        } else if (kind === 'task_started') {
          touch(at);
          turnOpen = true;
          turnCompleted = false;
        } else if (kind === 'task_complete' || kind === 'turn_aborted') {
          touch(at);
          turnOpen = false;
          turnCompleted = true;
          if (kind === 'task_complete' && typeof payload.last_agent_message === 'string') lastAssistantText = payload.last_agent_message;
          if (kind === 'turn_aborted' && payload.reason && payload.reason !== 'interrupted') {
            lastError = `Turn aborted: ${String(payload.reason)}`;
          }
        } else if (kind === 'token_count' && isObject(payload.info)) {
          const total = isObject(payload.info.total_token_usage) ? payload.info.total_token_usage : undefined;
          if (total) {
            const n = (k: string) => (typeof total[k] === 'number' ? (total[k] as number) : 0);
            const cached = n('cached_input_tokens');
            cumulativeUsage = { input: Math.max(0, n('input_tokens') - cached), output: n('output_tokens'), cacheRead: cached, cacheWrite: 0 };
          }
        } else if (kind === 'error' && typeof payload.message === 'string') {
          touch(at);
          lastError = truncate(payload.message, 160);
          if (at !== undefined) timeline.push({ at, kind: 'error', text: lastError, isError: true });
        }
        break;
      }
      case 'response_item': {
        const kind = payload.type;
        if (input.headerOnly) {
          touch(at);
          break;
        }
        if ((kind === 'function_call' || kind === 'custom_tool_call') && typeof payload.name === 'string') {
          touch(at);
          const callId = typeof payload.call_id === 'string' ? payload.call_id : `${toolCalls.length}`;
          const args = kind === 'function_call' ? parseArgs(payload.arguments) : { input: payload.input };
          const described = describeToolCall(payload.name, args, cwd);
          const call: ToolCall = { id: callId, name: payload.name, kind: described.kind, summary: described.summary };
          if (described.file) call.file = described.file;
          if (at !== undefined) call.startedAt = at;
          toolCalls.push(call);
          byCallId.set(callId, call);
          if (payload.name === 'spawn_agent' && isObject(args)) {
            spawns.set(callId, {
              callId,
              ...(typeof args.message === 'string' ? { prompt: args.message } : {}),
              ...(typeof args.agent_type === 'string' ? { agentType: args.agent_type } : {}),
            });
          }
          for (const f of described.writes) files.add(f);
          if (payload.name === 'update_plan' && isObject(args) && Array.isArray(args.plan)) {
            todos = args.plan
              .filter((p): p is Record<string, unknown> & { step: string } => isObject(p) && typeof p.step === 'string')
              .map((p) => ({ content: p.step, status: p.status === 'in_progress' ? 'in_progress' : p.status === 'completed' ? 'completed' : 'pending' }));
          }
          if (at !== undefined) timeline.push({ at, kind: 'tool-call', text: described.summary, toolName: payload.name });
        } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
          touch(at);
          const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
          const call = callId ? byCallId.get(callId) : undefined;
          const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
          const failed = toolOutputFailed(payload.output);
          const spawn = callId ? spawns.get(callId) : undefined;
          if (spawn) {
            const result = parseArgs(payload.output);
            if (isObject(result) && typeof result.agent_id === 'string') spawn.agentId = result.agent_id;
          }
          if (call) {
            if (at !== undefined) call.endedAt = at;
            if (output) call.resultPreview = truncate(output, 240);
            if (failed) call.isError = true;
          }
          if (at !== undefined) timeline.push({ at, kind: 'tool-result', text: call?.summary ?? 'Tool result', ...(call?.name ? { toolName: call.name } : {}), ...(failed ? { isError: true } : {}) });
        } else if (kind === 'message' && payload.role === 'assistant') {
          touch(at);
        }
        break;
      }
      default:
        break;
    }
  }

  if (cumulativeUsage) usage.add(model, cumulativeUsage);
  const lastCall = toolCalls[toolCalls.length - 1];
  const pendingToolCall = !!lastCall && lastCall.endedAt === undefined;
  const effectiveLast = lastActivityAt ?? input.mtimeMs;
  const status = deriveStatus({
    now: input.now,
    activeWindowMs: input.activeWindowMs,
    completed: !!parentThreadId && turnCompleted && !turnOpen,
    errored: !!lastError,
    pendingToolCall: pendingToolCall || turnOpen,
    ...(effectiveLast !== undefined ? { lastActivityAt: effectiveLast } : {}),
  });

  const id = sessionId ?? input.filePath;
  const project = resolveProject(cwd, {
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(input.isGitRoot ? { isGitRoot: input.isGitRoot } : {}),
    ...(input.homeDir ? { homeDir: input.homeDir } : {}),
  });
  const title = titleFromPrompt(firstUserText) || 'Untitled session';
  const inProgress = todos.find((t) => t.status === 'in_progress');

  const agent: AgentDetail = {
    id,
    runId: id,
    provider: 'codex',
    role: parentThreadId ? 'subagent' : 'main',
    depth: parentThreadId ? 1 : 0,
    title,
    status,
    toolCallCount: toolCalls.length,
    tokens: usage.total(),
    usageByModel: usage.models(),
    filesTouched: [...files],
    toolCalls,
    timeline,
    todos,
    ...(model ? { model } : {}),
    ...(agentType ? { agentType } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(effectiveLast !== undefined ? { lastActivityAt: effectiveLast } : {}),
    ...(status === 'finished' || status === 'errored' ? { endedAt: effectiveLast } : {}),
    ...(lastCall ? { currentAction: lastCall.summary } : {}),
    ...(inProgress ? { nowTodo: inProgress.content } : {}),
    ...(lastError ? { error: lastError } : {}),
    ...(firstUserText ? { firstMessage: firstUserText } : {}),
    ...(lastAssistantText ? { lastAssistantText: truncate(lastAssistantText, 400) } : {}),
    ...(parentThreadId ? { parentId: parentThreadId } : {}),
  };

  const run: RunSummary = {
    id,
    provider: 'codex',
    title,
    projectName: project.name,
    projectPath: project.path,
    cwd: cwd ?? '',
    filePath: input.filePath,
    status,
    agentCount: 1,
    tokensLoaded: !input.headerOnly,
    isEmpty: !firstUserText && toolCalls.length === 0 && !lastAssistantText,
    ...(input.headerOnly ? {} : { tokens: usage.total() }),
    ...(gitBranch ? { gitBranch } : {}),
    ...(model ? { model } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(effectiveLast !== undefined ? { lastActivityAt: effectiveLast } : {}),
  };

  return { run, agents: [agent], spawns: [...spawns.values()], ...(parentThreadId ? { parentThreadId } : {}) };
}

/** A word such as "error" in file contents or test output is not an exit status. */
function toolOutputFailed(raw: unknown): boolean {
  const value = typeof raw === 'string' ? parseArgs(raw) : raw;
  if (isObject(value)) {
    if (value.isError === true || value.is_error === true) return true;
    const metadata = isObject(value.metadata) ? value.metadata : undefined;
    const exitCode = value.exit_code ?? metadata?.exit_code;
    if (typeof exitCode === 'number') return exitCode !== 0;
  }
  const exit = typeof raw === 'string' ? raw.match(/^(?:process )?exited with code (-?\d+)\s*$/im) : undefined;
  return !!exit && Number(exit[1]) !== 0;
}

/** Resolve only known parents and break corrupt cycles deterministically. */
export function codexParentMap(sessions: { id: string; parentThreadId?: string }[]): Map<string, string> {
  const ids = new Set(sessions.map((session) => session.id));
  const parents = new Map<string, string>();
  for (const session of sessions) {
    if (session.parentThreadId && session.parentThreadId !== session.id && ids.has(session.parentThreadId)) parents.set(session.id, session.parentThreadId);
  }
  const checked = new Set<string>();
  for (const id of ids) {
    const path: string[] = [];
    const position = new Map<string, number>();
    let current: string | undefined = id;
    while (current !== undefined && !checked.has(current)) {
      const cycleStart = position.get(current);
      if (cycleStart !== undefined) {
        let root = current;
        for (const member of path.slice(cycleStart)) if (member < root) root = member;
        parents.delete(root);
        break;
      }
      position.set(current, path.length);
      path.push(current);
      current = parents.get(current);
    }
    for (const member of path) checked.add(member);
  }
  return parents;
}

/** Roll up a Codex tree without losing the root's project or title. */
export function summarizeCodexTree(root: RunSummary, descendants: RunSummary[]): RunSummary {
  const byId = new Map([[root.id, root]]);
  for (const run of descendants) if (!byId.has(run.id)) byId.set(run.id, run);
  const runs = [...byId.values()];
  const tokensLoaded = runs.every((run) => run.tokensLoaded && run.tokens !== undefined);
  let startedAt = root.startedAt;
  let lastActivityAt = root.lastActivityAt;
  let tokens = { ...EMPTY_USAGE };
  for (const run of runs) {
    if (run.startedAt !== undefined && (startedAt === undefined || run.startedAt < startedAt)) startedAt = run.startedAt;
    if (run.lastActivityAt !== undefined && (lastActivityAt === undefined || run.lastActivityAt > lastActivityAt)) lastActivityAt = run.lastActivityAt;
    if (run.tokens) tokens = addUsage(tokens, run.tokens);
  }
  const status = runs.some((run) => run.status === 'running') ? 'running' : runs.some((run) => run.status === 'errored') ? 'errored' : runs.some((run) => run.status === 'idle') ? 'idle' : 'finished';
  const summary: RunSummary = {
    ...root,
    status,
    agentCount: runs.length,
    tokensLoaded,
    isEmpty: runs.every((run) => run.isEmpty),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(lastActivityAt !== undefined ? { lastActivityAt } : {}),
  };
  if (tokensLoaded) summary.tokens = tokens;
  else delete summary.tokens;
  return summary;
}

/** Join separate rollouts into the same tree used by topology and the timeline. */
export function mergeCodexSessions(root: CodexParseResult, descendants: CodexParseResult[]): RunDetail {
  const byId = new Map([[root.run.id, root]]);
  for (const session of descendants) if (!byId.has(session.run.id)) byId.set(session.run.id, session);
  const sessions = [...byId.values()];
  const parents = codexParentMap(sessions.map((session) => ({ id: session.run.id, ...(session.parentThreadId ? { parentThreadId: session.parentThreadId } : {}) })));
  parents.delete(root.run.id);
  for (const session of sessions) if (session.run.id !== root.run.id && !parents.has(session.run.id)) parents.set(session.run.id, root.run.id);
  // Memoize whole ancestor paths so a deeply nested tree takes linear work.
  const depths = new Map([[root.run.id, 0]]);
  const depthOf = (id: string): number => {
    const path: string[] = [];
    let current = id;
    while (!depths.has(current)) {
      path.push(current);
      const parent = parents.get(current);
      if (parent === undefined) break;
      current = parent;
    }
    let depth = depths.get(current) ?? 0;
    for (const member of path.reverse()) depths.set(member, ++depth);
    return depths.get(id) ?? 0;
  };
  const spawnByAgent = new Map<string, CodexSpawn>();
  for (const session of sessions) for (const spawn of session.spawns) if (spawn.agentId) spawnByAgent.set(spawn.agentId, spawn);
  const agents: AgentDetail[] = [];
  for (const session of sessions) {
    const original = session.agents[0];
    if (!original) continue;
    const agent = { ...original, runId: root.run.id };
    if (agent.id === root.run.id) {
      agent.role = 'main';
      agent.depth = 0;
      delete agent.parentId;
    } else {
      agent.role = 'subagent';
      agent.parentId = parents.get(agent.id) ?? root.run.id;
      agent.depth = depthOf(agent.id);
      const spawn = spawnByAgent.get(agent.id);
      const prompt = spawn?.prompt ?? agent.firstMessage;
      if (prompt) {
        agent.prompt = prompt;
        agent.subtitle = truncate(cleanUserText(prompt), 120);
        agent.title = titleFromPrompt(prompt) || agent.title;
      }
      if (spawn) agent.spawnToolUseId = spawn.callId;
      if (!agent.agentType && spawn?.agentType) agent.agentType = spawn.agentType;
    }
    agents.push(agent);
  }
  agents.sort((a, b) => a.depth - b.depth || (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
  return { run: summarizeCodexTree(root.run, sessions.slice(1).map((session) => session.run)), agents };
}
