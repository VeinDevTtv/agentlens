import { Clock, Coins, Wrench } from 'lucide-react';
import type { AgentSummary } from '../../shared/types';
import { totalTokens } from '../../core/tokens';
import { formatCompact, formatDuration, shortModel } from '../lib/format';
import { StatusBadge } from './StatusBadge';

export interface AgentCardProps {
  agent: AgentSummary;
  now: number;
  selected?: boolean;
  onSelect?: (agentId: string) => void;
}

export function AgentCard({ agent, now, selected = false, onSelect }: AgentCardProps) {
  const end = agent.endedAt ?? (agent.status === 'running' ? now : agent.lastActivityAt);
  const elapsed = formatDuration(agent.startedAt, end);
  const roleLabel = agent.role === 'main' ? 'Main agent' : agent.agentType ? `Subagent · ${agent.agentType}` : 'Subagent';
  return (
    <button
      type="button"
      className={`agent-card ${agent.status}${selected ? ' selected' : ''}`}
      onClick={() => onSelect?.(agent.id)}
      aria-pressed={selected}
      aria-label={`${roleLabel}: ${agent.title}. ${agent.status}.`}
    >
      <div className="top">
        <span className="role">{roleLabel}</span>
        <StatusBadge status={agent.status} />
      </div>
      <div className="title">{agent.title}</div>
      {agent.subtitle && <div className="subtitle">{agent.subtitle}</div>}
      {agent.nowTodo && (
        <div className="line">
          <span className="label">Now</span>
          <span className="value">{agent.nowTodo}</span>
        </div>
      )}
      {agent.status === 'errored' && agent.error ? (
        <div className="line error">
          <span className="label">Error</span>
          <span className="value">{agent.error}</span>
        </div>
      ) : agent.currentAction ? (
        <div className="line">
          <span className="label">{agent.status === 'running' ? 'Currently' : 'Last'}</span>
          <span className="value">{agent.currentAction}</span>
        </div>
      ) : null}
      <div className="foot">
        {elapsed && (
          <span title="Elapsed">
            <Clock size={12} aria-hidden="true" /> {elapsed}
          </span>
        )}
        <span title="Tokens">
          <Coins size={12} aria-hidden="true" /> {formatCompact(totalTokens(agent.tokens))}
        </span>
        <span title="Tool calls">
          <Wrench size={12} aria-hidden="true" /> {agent.toolCallCount}
        </span>
        {agent.model && <span className="badge model">{shortModel(agent.model)}</span>}
      </div>
    </button>
  );
}
