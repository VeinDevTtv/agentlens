import { FolderOpen, GitBranch, PanelLeft, Workflow, GanttChartSquare } from 'lucide-react';
import { useMemo } from 'react';
import { estimateCost, formatCost } from '../../core/pricing';
import { totalTokens } from '../../core/tokens';
import type { RunDetail, RunSummary } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { formatCompact, formatDuration, formatRelative } from '../lib/format';
import { useStore } from '../store';
import { StatusBadge } from './StatusBadge';

export function Header({ run, detail }: { run: RunSummary | undefined; detail: RunDetail | undefined }) {
  const view = useStore((s) => s.view);
  const setView = useStore((s) => s.setView);
  const toggleSidebar = useStore((s) => s.toggleSidebar);
  const now = useStore((s) => s.now);
  const pricing = useStore((s) => s.settings.pricing);

  const cost = useMemo(() => {
    const usageByModel = detail?.agents.flatMap((agent) => agent.usageByModel) ?? [];
    return usageByModel.length ? estimateCost(usageByModel, pricing) : undefined;
  }, [detail, pricing]);
  const tokens = run?.tokens ? totalTokens(run.tokens) : undefined;
  const runningAgents = useMemo(() => detail?.agents.filter((agent) => agent.status === 'running').length ?? 0, [detail]);
  const end = run?.status === 'running' ? now : run?.lastActivityAt;

  return (
    <header className="header">
      <button type="button" className="icon-button" onClick={toggleSidebar} title="Toggle sidebar ([)" aria-label="Toggle sidebar">
        <PanelLeft size={16} aria-hidden="true" />
      </button>
      <div className="project">
        {run ? (
          <>
            <div className="project-name">
              {run.projectName}
              <StatusBadge status={run.status} />
              {run.gitBranch && (
                <span className="badge model" title="Git branch">
                  <GitBranch size={11} aria-hidden="true" /> {run.gitBranch}
                </span>
              )}
            </div>
            <div className="run-title">{run.title}</div>
            <button type="button" className="project-path" title="Reveal session log" onClick={() => void bridge()?.revealPath(run.filePath)} style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
              <FolderOpen size={11} aria-hidden="true" /> {run.cwd || run.projectPath}
            </button>
          </>
        ) : (
          <div className="project-name">Select a run</div>
        )}
      </div>
      {run && (
        <div className="stats" aria-label="Run statistics">
          <span>
            Agents <b>{detail?.agents.length ?? run.agentCount}</b>
            {runningAgents > 0 && <> · <b style={{ color: 'var(--running)' }}>{runningAgents} running</b></>}
          </span>
          <span>
            Tokens <b>{tokens === undefined ? '…' : formatCompact(tokens)}</b>
          </span>
          <span title={cost?.unpriced.length ? `No pricing for: ${cost.unpriced.join(', ')}` : 'Estimated from Settings → Pricing'}>
            Est. cost <b>{cost ? (cost.unpriced.length && cost.total === 0 ? 'Set pricing' : formatCost(cost.total)) : '…'}</b>
          </span>
          <span>
            Elapsed <b>{formatDuration(run.startedAt, end) || '–'}</b>
          </span>
          <span>
            Last activity <b>{formatRelative(run.lastActivityAt, now)}</b>
          </span>
        </div>
      )}
      <div className="segmented" role="tablist" aria-label="View">
        <button type="button" role="tab" aria-selected={view === 'topology'} aria-pressed={view === 'topology'} onClick={() => setView('topology')} title="Topology (1)">
          <Workflow size={13} aria-hidden="true" /> Topology
        </button>
        <button type="button" role="tab" aria-selected={view === 'timeline'} aria-pressed={view === 'timeline'} onClick={() => setView('timeline')} title="Timeline (2)">
          <GanttChartSquare size={13} aria-hidden="true" /> Timeline
        </button>
      </div>
    </header>
  );
}
