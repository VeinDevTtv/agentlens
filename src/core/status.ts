import type { AgentStatus } from '../shared/types';

export interface StatusInput {
  now: number;
  lastActivityAt?: number;
  /** Milliseconds of silence after which a running agent is considered idle. */
  activeWindowMs: number;
  /** The agent explicitly completed (subagent returned, or the session's last turn ended). */
  completed: boolean;
  /** The agent's last recorded event was an error. */
  errored: boolean;
  /** A tool call is pending with no result yet. */
  pendingToolCall: boolean;
  /** Main agents that stopped a long time ago read as finished rather than idle. */
  finishedAfterMs?: number;
}

export function deriveStatus(input: StatusInput): AgentStatus {
  const { now, lastActivityAt, activeWindowMs, completed, errored } = input;
  if (errored) return 'errored';
  if (completed) return 'finished';
  if (lastActivityAt === undefined) return 'idle';
  const silence = now - lastActivityAt;
  if (silence <= activeWindowMs) return 'running';
  const finishedAfter = input.finishedAfterMs ?? 30 * 60 * 1000;
  // A stale pending tool call usually means the process was killed; past the finished
  // threshold we call it finished either way, before that it reads as idle.
  if (silence >= finishedAfter) return 'finished';
  return 'idle';
}

export const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, errored: 1, idle: 2, finished: 3 };
