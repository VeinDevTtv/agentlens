/** Data model shared by the main process, preload bridge, and renderer. */

export type Provider = 'claude' | 'codex';
export type AgentStatus = 'running' | 'idle' | 'finished' | 'errored';
export type AgentRole = 'main' | 'subagent';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsage extends TokenUsage {
  model: string;
  /** Number of API responses attributed to this model. */
  calls: number;
}

export type ToolKind = 'edit' | 'read' | 'shell' | 'search' | 'delegate' | 'web' | 'plan' | 'other';

export interface ToolCall {
  id: string;
  name: string;
  kind: ToolKind;
  /** Human-readable description, e.g. "Editing src/App.tsx". */
  summary: string;
  /** Workspace-relative file path when the call targets a file. */
  file?: string;
  startedAt?: number;
  endedAt?: number;
  isError?: boolean;
  /** Short excerpt of the result, for the side panel. */
  resultPreview?: string;
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
}

export type TimelineKind = 'user' | 'assistant' | 'tool-call' | 'tool-result' | 'spawn' | 'error' | 'finish';

export interface TimelineEvent {
  at: number;
  kind: TimelineKind;
  text: string;
  toolName?: string;
  isError?: boolean;
}

export interface AgentSummary {
  id: string;
  runId: string;
  provider: Provider;
  role: AgentRole;
  parentId?: string;
  /** The parent's tool-use id that spawned this agent. */
  spawnToolUseId?: string;
  depth: number;
  /** Task title: Agent `description` for subagents, shortened first prompt for the main agent. */
  title: string;
  /** Truncated prompt for subagents. */
  subtitle?: string;
  /** Full prompt that was handed to a subagent. */
  prompt?: string;
  agentType?: string;
  status: AgentStatus;
  /** "Currently:" line built from the latest tool call. */
  currentAction?: string;
  /** In-progress todo item, when a todo list exists. */
  nowTodo?: string;
  model?: string;
  startedAt?: number;
  lastActivityAt?: number;
  endedAt?: number;
  toolCallCount: number;
  tokens: TokenUsage;
  usageByModel: ModelUsage[];
  filesTouched: string[];
  error?: string;
}

export interface AgentDetail extends AgentSummary {
  toolCalls: ToolCall[];
  timeline: TimelineEvent[];
  todos: TodoItem[];
  /** First user message (main agent) or the prompt (subagent). */
  firstMessage?: string;
  /** Latest assistant text, for a quick read of what the agent last said. */
  lastAssistantText?: string;
}

export interface RunSummary {
  id: string;
  provider: Provider;
  title: string;
  projectName: string;
  projectPath: string;
  cwd: string;
  filePath: string;
  gitBranch?: string;
  model?: string;
  startedAt?: number;
  lastActivityAt?: number;
  status: AgentStatus;
  agentCount: number;
  /** Populated lazily once the run has been parsed in full. */
  tokens?: TokenUsage;
  tokensLoaded: boolean;
  /** No assistant turn was ever recorded (e.g. an aborted or scheduled-job shell). */
  isEmpty: boolean;
}

export interface ProjectGroup {
  name: string;
  path: string;
  runIds: string[];
  lastActivityAt?: number;
  runningCount: number;
}

export interface RunDetail {
  run: RunSummary;
  agents: AgentDetail[];
}

export interface DiscoverySource {
  provider: Provider;
  path: string;
  exists: boolean;
  sessionCount: number;
  error?: string;
}

export interface Snapshot {
  runs: RunSummary[];
  sources: DiscoverySource[];
  scannedAt: number;
}

export type ThemePreference = 'light' | 'dark' | 'system';

export interface ModelPricing {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface Settings {
  claudeSessionsDir: string;
  codexSessionsDir: string;
  theme: ThemePreference;
  notifications: boolean;
  /** Seconds without log activity before a running agent is considered idle. */
  activeWindowSeconds: number;
  pricing: Record<string, ModelPricing>;
}

export interface AgentStatusChange {
  runId: string;
  agentId: string;
  title: string;
  projectName: string;
  from: AgentStatus;
  to: AgentStatus;
}
