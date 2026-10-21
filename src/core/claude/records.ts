/** Tolerant typing and parsing for Claude Code session JSONL records. */

export interface ClaudeContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

export interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface ClaudeMessage {
  id?: string;
  role?: string;
  model?: string;
  stop_reason?: string | null;
  usage?: ClaudeUsage;
  content?: string | ClaudeContentBlock[];
}

export interface ClaudeRecord {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  agentId?: string;
  sessionId?: string;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  message?: ClaudeMessage;
  toolUseResult?: unknown;
  isApiErrorMessage?: boolean;
  aiTitle?: string;
  subtype?: string;
  attachment?: { type?: string; snapshot?: { workingDirectory?: string; isGitRepo?: boolean } };
}

export interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
}

export function parseJsonl(text: string): ClaudeRecord[] {
  const records: ClaudeRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const value = JSON.parse(trimmed) as unknown;
      if (value && typeof value === 'object' && typeof (value as { type?: unknown }).type === 'string') {
        records.push(value as ClaudeRecord);
      }
    } catch {
      // Partial line from a file still being written, or junk. Skip.
    }
  }
  return records;
}

export function parseSubagentMeta(text: string | undefined): SubagentMeta | undefined {
  if (!text) return undefined;
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as SubagentMeta) : undefined;
  } catch {
    return undefined;
  }
}

export function timestampMs(record: { timestamp?: string }): number | undefined {
  if (!record.timestamp) return undefined;
  const ms = Date.parse(record.timestamp);
  return Number.isNaN(ms) ? undefined : ms;
}

export function contentBlocks(message: ClaudeMessage | undefined): ClaudeContentBlock[] {
  if (!message) return [];
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''))
    .filter(Boolean)
    .join('\n');
}
