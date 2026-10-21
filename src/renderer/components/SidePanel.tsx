import { AlertTriangle, Bot, CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDot, FileText, MessageSquare, Sparkles, Wrench, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { estimateCost, formatCost } from '../../core/pricing';
import { totalTokens } from '../../core/tokens';
import type { AgentDetail, RunSummary, TimelineEvent, ToolCall } from '../../shared/types';
import { formatCompact, formatDuration, formatExact, formatTime, shortModel } from '../lib/format';
import { useStore } from '../store';
import { StatusBadge } from './StatusBadge';

type Tab = 'task' | 'timeline' | 'tools' | 'files' | 'tokens';
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'task', label: 'Task' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'tools', label: 'Tool calls' },
  { id: 'files', label: 'Files' },
  { id: 'tokens', label: 'Tokens' },
];

function TimelineIcon({ event }: { event: TimelineEvent }) {
  const size = 13;
  switch (event.kind) {
    case 'user':
      return <MessageSquare size={size} aria-hidden="true" />;
    case 'assistant':
      return <Sparkles size={size} aria-hidden="true" />;
    case 'spawn':
      return <Bot size={size} aria-hidden="true" />;
    case 'error':
      return <AlertTriangle size={size} aria-hidden="true" />;
    case 'finish':
      return <CheckCircle2 size={size} aria-hidden="true" />;
    case 'tool-result':
      return event.isError ? <AlertTriangle size={size} aria-hidden="true" /> : <CircleDot size={size} aria-hidden="true" />;
    default:
      return <Wrench size={size} aria-hidden="true" />;
  }
}

function TaskTab({ agent, run }: { agent: AgentDetail; run: RunSummary }) {
  const [expanded, setExpanded] = useState(false);
  const prompt = agent.prompt ?? agent.firstMessage;
  const long = (prompt?.length ?? 0) > 400;
  return (
    <div className="panel-section-list">
      <section>
        <h3>{agent.role === 'main' ? 'Goal' : 'Task'}</h3>
        <p className="panel-title">{agent.title}</p>
        <div className="panel-badges">
          <StatusBadge status={agent.status} />
          {agent.agentType && <span className="badge type">{agent.agentType}</span>}
          {agent.model && <span className="badge model">{shortModel(agent.model)}</span>}
          <span className="badge model">{run.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
        </div>
      </section>
      {agent.nowTodo && (
        <section>
          <h3>Now</h3>
          <p>{agent.nowTodo}</p>
        </section>
      )}
      {agent.currentAction && (
        <section>
          <h3>{agent.status === 'running' ? 'Currently' : 'Last action'}</h3>
          <p>{agent.currentAction}</p>
        </section>
      )}
      {agent.error && (
        <section>
          <h3>Error</h3>
          <p className="error-text">{agent.error}</p>
        </section>
      )}
      {prompt && (
        <section>
          <h3>{agent.role === 'main' ? 'First message' : 'Prompt'}</h3>
          <pre className={`prompt${expanded || !long ? '' : ' clamped'}`}>{prompt}</pre>
          {long && (
            <button type="button" className="btn small" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
              {expanded ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />} {expanded ? 'Show less' : 'Show full prompt'}
            </button>
          )}
        </section>
      )}
      {agent.todos.length > 0 && (
        <section>
          <h3>Task list</h3>
          <ul className="todo-list">
            {agent.todos.map((todo, index) => (
              <li key={index} className={todo.status}>
                {todo.status === 'completed' ? <CheckCircle2 size={13} aria-hidden="true" /> : todo.status === 'in_progress' ? <CircleDot size={13} aria-hidden="true" /> : <Circle size={13} aria-hidden="true" />}
                <span>{todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content}</span>
                <span className="sr-only">({todo.status.replace('_', ' ')})</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {agent.lastAssistantText && (
        <section>
          <h3>Last said</h3>
          <p className="muted">{agent.lastAssistantText}</p>
        </section>
      )}
    </div>
  );
}

function TimelineTab({ agent }: { agent: AgentDetail }) {
  const events = useMemo(() => [...agent.timeline].reverse(), [agent.timeline]);
  if (!events.length) return <p className="muted panel-pad">No events recorded yet.</p>;
  return (
    <ol className="event-list" aria-label="Timeline, newest first">
      {events.map((event, index) => (
        <li key={`${event.at}-${index}`} className={`event ${event.kind}${event.isError ? ' error' : ''}`}>
          <span className="time mono">{formatTime(event.at)}</span>
          <span className="icon">
            <TimelineIcon event={event} />
          </span>
          <span className="text">
            {event.toolName && event.kind !== 'spawn' && <span className="tool-name mono">{event.toolName}</span>} {event.text}
          </span>
        </li>
      ))}
    </ol>
  );
}

function ToolsTab({ agent }: { agent: AgentDetail }) {
  const calls = useMemo(() => [...agent.toolCalls].reverse(), [agent.toolCalls]);
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const call of agent.toolCalls) map.set(call.name, (map.get(call.name) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [agent.toolCalls]);
  if (!calls.length) return <p className="muted panel-pad">No tool calls yet.</p>;
  return (
    <div>
      <div className="tool-counts" aria-label="Tool call counts">
        {counts.map(([name, count]) => (
          <span key={name} className="badge model">
            {name} × {count}
          </span>
        ))}
      </div>
      <ol className="tool-list" aria-label="Tool calls, newest first">
        {calls.map((call: ToolCall) => (
          <li key={call.id} className={call.isError ? 'error' : ''}>
            <div className="tool-head">
              <span className="tool-name mono">{call.name}</span>
              <span className="summary">{call.summary}</span>
              <span className="duration mono">{call.endedAt !== undefined ? formatDuration(call.startedAt, call.endedAt) : call.startedAt ? 'pending' : ''}</span>
            </div>
            {call.resultPreview && <pre className="result-preview">{call.resultPreview}</pre>}
          </li>
        ))}
      </ol>
    </div>
  );
}

function FilesTab({ agent }: { agent: AgentDetail }) {
  if (!agent.filesTouched.length) return <p className="muted panel-pad">No files written by this agent.</p>;
  return (
    <ul className="file-list">
      {agent.filesTouched.map((file) => (
        <li key={file}>
          <FileText size={13} aria-hidden="true" /> <span className="mono">{file}</span>
        </li>
      ))}
    </ul>
  );
}

function TokensTab({ agent }: { agent: AgentDetail }) {
  const pricing = useStore((s) => s.settings.pricing);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const cost = estimateCost(agent.usageByModel, pricing);
  const total = totalTokens(agent.tokens);
  const rows: Array<[string, number]> = [
    ['Input', agent.tokens.input],
    ['Output', agent.tokens.output],
    ['Cache read', agent.tokens.cacheRead],
    ['Cache write', agent.tokens.cacheWrite],
  ];
  return (
    <div className="panel-section-list">
      <section>
        <h3>Totals</h3>
        <table className="kv">
          <tbody>
            {rows.map(([label, value]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td className="mono">{formatExact(value)}</td>
                <td className="bar-cell">
                  <span className="bar" style={{ width: total ? `${Math.max(2, (value / total) * 100)}%` : 0 }} />
                </td>
              </tr>
            ))}
            <tr className="total">
              <th scope="row">Total</th>
              <td className="mono">{formatExact(total)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </section>
      <section>
        <h3>By model</h3>
        {agent.usageByModel.length === 0 ? (
          <p className="muted">No usage recorded.</p>
        ) : (
          <table className="kv">
            <thead>
              <tr>
                <th scope="col">Model</th>
                <th scope="col">Calls</th>
                <th scope="col">Tokens</th>
                <th scope="col">Est. cost</th>
              </tr>
            </thead>
            <tbody>
              {agent.usageByModel.map((usage) => {
                const entry = cost.byModel.find((c) => c.model === usage.model);
                return (
                  <tr key={usage.model}>
                    <th scope="row" className="mono">{usage.model}</th>
                    <td className="mono">{usage.calls}</td>
                    <td className="mono">{formatCompact(totalTokens(usage))}</td>
                    <td className="mono">{entry?.cost === undefined ? <button type="button" className="link" onClick={() => setSettingsOpen(true)}>Set pricing</button> : formatCost(entry.cost)}</td>
                  </tr>
                );
              })}
              <tr className="total">
                <th scope="row">Total</th>
                <td />
                <td className="mono">{formatCompact(total)}</td>
                <td className="mono">{cost.unpriced.length && cost.total === 0 ? '–' : formatCost(cost.total)}</td>
              </tr>
            </tbody>
          </table>
        )}
        <p className="muted small">Prices are editable in Settings. Estimates use list prices per million tokens and ignore batch or tier discounts.</p>
      </section>
    </div>
  );
}

export function SidePanel({ agent, run, onClose }: { agent: AgentDetail; run: RunSummary; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('task');
  const now = useStore((s) => s.now);
  const end = agent.endedAt ?? (agent.status === 'running' ? now : agent.lastActivityAt);
  return (
    <aside className="side-panel" aria-label={`Details for ${agent.title}`}>
      <div className="panel-header">
        <div className="panel-heading">
          <span className="role">{agent.role === 'main' ? 'Main agent' : 'Subagent'}</span>
          <span className="panel-run-title">{agent.title}</span>
          <span className="muted small">
            {formatDuration(agent.startedAt, end) && `${formatDuration(agent.startedAt, end)} · `}
            {agent.toolCallCount} tool calls · {formatCompact(totalTokens(agent.tokens))} tokens
          </span>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close panel (Esc)" title="Close (Esc)">
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="tabs" role="tablist" aria-label="Agent details">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
            {t.id === 'tools' && agent.toolCallCount > 0 && <span className="count">{agent.toolCallCount}</span>}
            {t.id === 'files' && agent.filesTouched.length > 0 && <span className="count">{agent.filesTouched.length}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {tab === 'task' && <TaskTab agent={agent} run={run} />}
        {tab === 'timeline' && <TimelineTab agent={agent} />}
        {tab === 'tools' && <ToolsTab agent={agent} />}
        {tab === 'files' && <FilesTab agent={agent} />}
        {tab === 'tokens' && <TokensTab agent={agent} />}
      </div>
    </aside>
  );
}
