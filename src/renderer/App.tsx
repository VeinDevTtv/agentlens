import { AlertTriangle, FolderSearch, Inbox, Loader2 } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { HelpOverlay } from './components/HelpOverlay';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { Topology } from './components/Topology';
import { useClock, useKeyboardShortcuts, useMonitor, useNotifications, useSelectedRun, useTheme } from './hooks';
import { bridge } from './lib/bridge';
import { groupByProject, matchesFilters, sortRuns } from './lib/selectors';
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
  const view = useStore((s) => s.view);
  const now = useStore((s) => s.now);
  const run = snapshot?.runs.find((r) => r.id === selectedRunId);
  const selectedAgent = detail?.agents.find((a) => a.id === selectedAgentId);

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
    <div className="workspace">
      {view === 'topology' ? (
        <Topology agents={detail.agents} now={now} selectedAgentId={selectedAgentId} onSelect={selectAgent} />
      ) : (
        <Timeline agents={detail.agents} now={now} selectedAgentId={selectedAgentId} onSelect={selectAgent} />
      )}
      {selectedAgent && <SidePanel key={selectedAgent.id} agent={selectedAgent} run={detail.run} onClose={() => selectAgent(undefined)} />}
    </div>
  );
}

export default function App() {
  useMonitor();
  useSelectedRun();
  useClock();
  useTheme();
  useNotifications();
  const sidebarCollapsed = useStore((s) => s.sidebarCollapsed);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const run = useStore((s) => s.snapshot?.runs.find((r) => r.id === selectedRunId));
  const detail = useStore((s) => (selectedRunId ? s.details[selectedRunId] : undefined));
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const helpOpen = useStore((s) => s.helpOpen);
  const setHelpOpen = useStore((s) => s.setHelpOpen);

  // Same ordering as the sidebar, so j/k moves the way the eye does.
  const orderedRunIds = useCallback(() => {
    const s = useStore.getState();
    const runs = (s.snapshot?.runs ?? []).filter((r) => matchesFilters(r, s)).sort(sortRuns);
    return groupByProject(runs).flatMap((g) => (s.collapsedProjects[g.name] ? [] : g.runIds));
  }, []);
  useKeyboardShortcuts(orderedRunIds);

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
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {helpOpen && <HelpOverlay onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
