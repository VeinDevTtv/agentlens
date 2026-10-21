import { useEffect, useMemo, useRef, useState } from 'react';
import type { AgentDetail } from '../../shared/types';
import { formatDuration, formatTime } from '../lib/format';
import { STATUS_LABEL } from './StatusBadge';

const ROW_HEIGHT = 34;
const LABEL_WIDTH = 260;
const AXIS_HEIGHT = 28;

function niceStep(spanMs: number, targetTicks = 8): number {
  const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400].map((s) => s * 1000);
  const raw = spanMs / targetTicks;
  return steps.find((s) => s >= raw) ?? steps[steps.length - 1] ?? 1000;
}

export function Timeline({ agents, now, selectedAgentId, onSelect }: { agents: AgentDetail[]; now: number; selectedAgentId: string | undefined; onSelect: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<string | undefined>(undefined);
  const [containerWidth, setContainerWidth] = useState(900);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setContainerWidth(entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const rows = useMemo(() => {
    const byId = new Map(agents.map((a) => [a.id, a]));
    const ordered = [...agents].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
    const depthOf = (agent: AgentDetail): number => {
      let depth = 0;
      let current: AgentDetail | undefined = agent;
      const seen = new Set<string>();
      while (current?.parentId && byId.has(current.parentId) && !seen.has(current.id)) {
        seen.add(current.id);
        current = byId.get(current.parentId);
        depth += 1;
      }
      return depth;
    };
    return ordered.map((agent) => ({ agent, depth: depthOf(agent) }));
  }, [agents]);

  const starts = rows.map((r) => r.agent.startedAt).filter((v): v is number => v !== undefined);
  if (!starts.length) {
    return <p className="muted panel-pad" style={{ padding: 24 }}>No timestamps recorded for this run yet.</p>;
  }
  const minStart = Math.min(...starts);
  const endOf = (agent: AgentDetail) => agent.endedAt ?? (agent.status === 'running' ? now : (agent.lastActivityAt ?? agent.startedAt ?? now));
  const maxEnd = Math.max(...rows.map((r) => endOf(r.agent)), minStart + 1000);
  const span = maxEnd - minStart;
  const step = niceStep(span);
  const ticks: number[] = [];
  for (let t = Math.ceil(minStart / step) * step; t <= maxEnd; t += step) ticks.push(t);

  const width = Math.max(600, containerWidth - LABEL_WIDTH - 32);
  const x = (time: number) => ((time - minStart) / span) * width;
  const height = AXIS_HEIGHT + rows.length * ROW_HEIGHT;

  return (
    <div className="timeline" ref={containerRef} role="region" aria-label="Agent timeline">
      <div className="timeline-scroll">
        <table className="timeline-table" aria-label="Agents in start order">
          <caption className="sr-only">Gantt chart of when each agent started and finished</caption>
          <thead>
            <tr style={{ height: AXIS_HEIGHT }}>
              <th scope="col" style={{ width: LABEL_WIDTH }}>
                Agent
              </th>
              <th scope="col" className="axis-cell">
                <svg width={width} height={AXIS_HEIGHT} aria-hidden="true">
                  {ticks.map((t) => (
                    <g key={t} transform={`translate(${x(t)},0)`}>
                      <line y1={AXIS_HEIGHT - 6} y2={AXIS_HEIGHT} className="tick" />
                      <text y={AXIS_HEIGHT - 10} textAnchor="middle" className="tick-label">
                        {step >= 60_000 ? formatTime(t).replace(/:\d\d(\s|$)/, '$1') : formatTime(t)}
                      </text>
                    </g>
                  ))}
                </svg>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ agent, depth }) => {
              const start = agent.startedAt ?? minStart;
              const end = endOf(agent);
              const left = x(start);
              const barWidth = Math.max(3, x(end) - left);
              const selected = agent.id === selectedAgentId;
              return (
                <tr key={agent.id} className={`${selected ? 'selected' : ''}${hover === agent.id ? ' hover' : ''}`} style={{ height: ROW_HEIGHT }}>
                  <th scope="row" style={{ paddingLeft: 10 + depth * 16 }}>
                    <button type="button" className="timeline-label" onClick={() => onSelect(agent.id)} aria-pressed={selected} title={agent.title}>
                      <span className={`status-dot ${agent.status}`} aria-hidden="true" style={{ marginTop: 0 }} />
                      <span className="label-text">{agent.title}</span>
                    </button>
                  </th>
                  <td className="bar-cell">
                    <svg width={width} height={ROW_HEIGHT} className="bar-svg">
                      {ticks.map((t) => (
                        <line key={t} x1={x(t)} x2={x(t)} y1={0} y2={ROW_HEIGHT} className="grid" />
                      ))}
                      <g
                        role="button"
                        tabIndex={0}
                        aria-label={`${agent.title}: ${STATUS_LABEL[agent.status]}, started ${formatTime(start)}, ${formatDuration(start, end)}`}
                        onClick={() => onSelect(agent.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onSelect(agent.id);
                          }
                        }}
                        onMouseEnter={() => setHover(agent.id)}
                        onMouseLeave={() => setHover(undefined)}
                        className="bar-group"
                      >
                        <rect x={left} y={8} width={barWidth} height={ROW_HEIGHT - 16} rx={4} className={`gantt-bar ${agent.status}${selected ? ' selected' : ''}`} />
                        {agent.timeline
                          .filter((e) => e.kind === 'spawn')
                          .map((e, i) => (
                            <circle key={i} cx={x(e.at)} cy={ROW_HEIGHT / 2} r={3} className="spawn-mark" />
                          ))}
                        {barWidth > 54 && (
                          <text x={left + 6} y={ROW_HEIGHT / 2 + 4} className="bar-text">
                            {formatDuration(start, end)}
                          </text>
                        )}
                      </g>
                    </svg>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <svg className="now-line" width={width} height={height} style={{ left: LABEL_WIDTH }} aria-hidden="true">
          {maxEnd >= now - 1000 && <line x1={x(Math.min(now, maxEnd))} x2={x(Math.min(now, maxEnd))} y1={AXIS_HEIGHT} y2={height} className="now" />}
        </svg>
      </div>
      <div className="timeline-legend" aria-hidden="true">
        {(Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((s) => (
          <span key={s}>
            <i className={`gantt-swatch ${s}`} /> {STATUS_LABEL[s]}
          </span>
        ))}
        <span>
          <i className="spawn-swatch" /> Subagent spawned
        </span>
        <span>
          <i className="now-swatch" /> Now
        </span>
      </div>
    </div>
  );
}
