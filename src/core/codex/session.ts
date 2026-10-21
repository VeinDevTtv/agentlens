import type { AgentDetail, RunDetail, RunSummary, TimelineEvent, TodoItem, ToolCall } from '../../shared/types';
import { describeToolCall } from '../activity';
import { resolveProject } from '../project';
import { deriveStatus } from '../status';
import { cleanUserText, titleFromPrompt, truncate } from '../text';
import { UsageAccumulator } from '../tokens';

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
  return !!value && typeof value === 'object';
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

/** Find a parent thread id in `thread_source`, whatever shape the CLI version used. */
function parentThreadOf(source: unknown): string | undefined {
  if (!isObject(source)) return undefined;
  for (const [key, value] of Object.entries(source)) {
    if (key === 'parent_thread_id' && typeof value === 'string') return value;
    const nested = parentThreadOf(value);
    if (nested) return nested;
  }
  return undefined;
}

export interface CodexParseResult extends RunDetail {
  /** Set when this rollout is itself a subagent of another thread. */
  parentThreadId?: string;
}

/** Parse a Codex rollout JSONL file into a single-agent run (plus parent linkage when present). */
export function parseCodexSession(input: CodexSessionInput): CodexParseResult {
  const lines = parseLines(input.text);
  const usage = new UsageAccumulator();
  const toolCalls: ToolCall[] = [];
  const byCallId = new Map<string, ToolCall>();
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
  let turnOpen = false;
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
        if (typeof payload.id === 'string') sessionId = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (isObject(payload.git)) {
          if (typeof payload.git.repository_url === 'string') repositoryUrl = payload.git.repository_url;
          if (typeof payload.git.branch === 'string') gitBranch = payload.git.branch;
        }
        parentThreadId = parentThreadOf(payload.thread_source);
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
        } else if (kind === 'agent_message' && typeof payload.message === 'string') {
          touch(at);
          lastAssistantText = payload.message;
          if (at !== undefined) timeline.push({ at, kind: 'assistant', text: truncate(payload.message, 140) });
        } else if (kind === 'task_started') {
          touch(at);
          turnOpen = true;
        } else if (kind === 'task_complete' || kind === 'turn_aborted') {
          touch(at);
          turnOpen = false;
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
          for (const f of described.writes) files.add(f);
          if (payload.name === 'update_plan' && isObject(args) && Array.isArray(args.plan)) {
            todos = args.plan
              .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.step === 'string')
              .map((p) => ({ content: p.step as string, status: p.status === 'in_progress' ? 'in_progress' : p.status === 'completed' ? 'completed' : 'pending' }));
          }
          if (at !== undefined) timeline.push({ at, kind: 'tool-call', text: described.summary, toolName: payload.name });
        } else if (kind === 'function_call_output' || kind === 'custom_tool_call_output') {
          touch(at);
          const callId = typeof payload.call_id === 'string' ? payload.call_id : undefined;
          const call = callId ? byCallId.get(callId) : undefined;
          const output = typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '');
          const failed = /exited with code [1-9]|\berror\b/i.test(output.slice(0, 200)) && !/exited with code 0/.test(output);
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
    completed: false,
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

  return { run, agents: [agent], ...(parentThreadId ? { parentThreadId } : {}) };
}
