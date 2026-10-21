import { AlertTriangle, FolderSearch, Inbox, Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { AgentCard } from './components/AgentCard';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useClock, useMonitor, useSelectedRun, useTheme } from './hooks';
import { bridge } from './lib/bridge';
import { useStore } from './store';

function SourcesEmptyState() {
  const sources = useStore((s) => s.snapshot?.sources ?? []);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const missing = sources.filter((s) => !s.exists);
  return (
    <EmptyState
      icon={FolderSearch}
      title="No sessions found"
      actions={
        <>
          <button type="button" className="btn primary" onClick={() => setSettingsOpen(true)}>
            Choose session directory
          </button>
          <button type="button" className="btn" onClick={() => void bridge()?.rescan()}>
            Rescan
          </button>
        </>
      }
    >
      <p>AgentLens reads Claude Code and Codex logs from your machine. Nothing was found in:</p>
      {sources.map((s) => (
        <p key={s.provider}>
          <code>{s.path}</code> {s.exists ? `(${s.sessionCount} sessions)` : '(directory does not exist)'}
        </p>
      ))}
      {missing.length === sources.length && <p>Start a Claude Code or Codex session, or point AgentLens at a different directory in Settings.</p>}
    </EmptyState>
  );
}

function MainArea() {
  const snapshot = useStore((s) => s.snapshot);
  const loading = useStore((s) => s.loading);
  const snapshotError = useStore((s) => s.snapshotError);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const detail = useStore((s) => (selectedRunId ? s.details[selectedRunId] : undefined));
  const detailLoading = useStore((s) => s.detailLoading);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const selectAgent = useStore((s) => s.selectAgent);
  const now = useStore((s) => s.now);
  const run = snapshot?.runs.find((r) => r.id === selectedRunId);

  if (snapshotError) {
    return (
      <EmptyState icon={AlertTriangle} title="Could not read sessions">
        <p>{snapshotError}</p>
      </EmptyState>
    );
  }
  if (loading) {
    return (
      <EmptyState icon={Loader2} title="Scanning session logs">
        <p>Reading the head of each session file. Large histories take a few seconds.</p>
      </EmptyState>
    );
  }
  if (!snapshot || snapshot.runs.length === 0) return <SourcesEmptyState />;
  if (!run) {
    return (
      <EmptyState icon={Inbox} title="Pick a run">
        <p>
          Choose a run from the sidebar to see its agents. Press <kbd>/</kbd> to search, <kbd>j</kbd> and <kbd>k</kbd> to move, <kbd>?</kbd> for all shortcuts.
        </p>
      </EmptyState>
    );
  }
  if (!detail && detailLoading) {
    return (
      <EmptyState icon={Loader2} title="Loading run">
        <p>Parsing the transcript and subagent logs.</p>
      </EmptyState>
    );
  }
  if (!detail) {
    return (
      <EmptyState icon={AlertTriangle} title="Run could not be loaded">
        <p>The session file may have been removed. Try rescanning.</p>
      </EmptyState>
    );
  }
  return (
    <div className="agent-grid">
      {detail.agents.map((agent) => (
        <AgentCard key={agent.id} agent={agent} now={now} selected={agent.id === selectedAgentId} onSelect={selectAgent} />
      ))}
    </div>
  );
}

export default function App() {
  useMonitor();
  useSelectedRun();
  useClock();
  useTheme();
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const run = useStore((s) => s.snapshot?.runs.find((r) => r.id === selectedRunId));
  const detail = useStore((s) => (selectedRunId ? s.details[selectedRunId] : undefined));

  useEffect(() => {
    if (bridge()?.platform === 'darwin') document.documentElement.classList.add('mac');
  }, []);

  return (
    <div className={`app${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <Sidebar />
      <main className="main">
        <Header run={run} detail={detail} />
        <MainArea />
      </main>
    </div>
  );
}
