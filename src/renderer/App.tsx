import { AlertTriangle, FolderSearch, Inbox, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect } from 'react';
import { ChatView } from './components/ChatView';
import { EmptyState } from './components/EmptyState';
import { Header } from './components/Header';
import { HelpOverlay } from './components/HelpOverlay';
import { NewChatDialog } from './components/NewChatDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { Sidebar } from './components/Sidebar';
import { SidePanel } from './components/SidePanel';
import { Timeline } from './components/Timeline';
import { Topology } from './components/Topology';
import { WorkflowDialog } from './components/WorkflowDialog';
import { WorkflowView } from './components/WorkflowView';
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
  const detailError = useStore((s) => s.detailError);
  const retrySelectedRun = useStore((s) => s.retrySelectedRun);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const selectedAgentId = useStore((s) => s.selectedAgentId);
  const selectAgent = useStore((s) => s.selectAgent);
  const view = useStore((s) => s.view);
  const now = useStore((s) => s.now);
  const selectedWorkflow = useStore((s) => (s.selectedWorkflowId ? s.workflows.find((w) => w.id === s.selectedWorkflowId) : undefined));
  const selectedChat = useStore((s) => (s.selectedChatId ? s.chats.find((c) => c.id === s.selectedChatId) : undefined));
  const run = snapshot?.runs.find((r) => r.id === selectedRunId);
  const selectedAgent = detail?.agents.find((a) => a.id === selectedAgentId);

  if (selectedChat) return <ChatView key={selectedChat.id} chat={selectedChat} />;
  if (selectedWorkflow) return <WorkflowView key={selectedWorkflow.id} workflow={selectedWorkflow} />;
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
    if (selectedRunId) {
      return (
        <EmptyState
          icon={AlertTriangle}
          title="Run is no longer available"
          actions={<button type="button" className="btn" onClick={() => setSettingsOpen(true)}>Check session directory</button>}
        >
          <p>The session was removed from the current sources. Choose another run from the sidebar or check the session directory in Settings.</p>
        </EmptyState>
      );
    }
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
      <EmptyState
        icon={AlertTriangle}
        title="Run could not be loaded"
        actions={
          <>
            <button type="button" className="btn primary" onClick={retrySelectedRun}>Retry</button>
            <button type="button" className="btn" onClick={() => setSettingsOpen(true)}>Check session directory</button>
          </>
        }
      >
        <p>{detailError ?? 'The session may have changed while it was being read. Retry to load the latest available detail.'}</p>
      </EmptyState>
    );
  }
  return (
    <div className="run-workspace">
      {(detailError || detail.stale || run.tokensStale || detailLoading) && (
        <div className={`run-refresh-status${detailError ? ' error' : ''}`} role="status">
          {detailError ? <AlertTriangle size={15} aria-hidden="true" /> : <RefreshCw size={15} aria-hidden="true" />}
          <span>
            {detailError ? `Could not refresh this run. Showing the last available detail. ${detailError}` : detailLoading ? 'Refreshing this run. Showing the last available detail.' : 'This snapshot may be out of date. Refresh to read the latest available detail.'}
          </span>
          {!detailLoading && <button type="button" className="btn small" onClick={retrySelectedRun}>Refresh</button>}
        </div>
      )}
      <div className="workspace" aria-busy={detailLoading}>
        {view === 'topology' ? (
          <Topology agents={detail.agents} now={now} selectedAgentId={selectedAgentId} onSelect={selectAgent} />
        ) : (
          <Timeline agents={detail.agents} now={now} selectedAgentId={selectedAgentId} onSelect={selectAgent} />
        )}
        {selectedAgent && <SidePanel key={selectedAgent.id} agent={selectedAgent} run={detail.run} onClose={() => selectAgent(undefined)} />}
      </div>
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
  const workflowDialogOpen = useStore((s) => s.workflowDialogOpen);
  const setWorkflowDialogOpen = useStore((s) => s.setWorkflowDialogOpen);
  const chatDialogOpen = useStore((s) => s.chatDialogOpen);
  const setChatDialogOpen = useStore((s) => s.setChatDialogOpen);

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
      {workflowDialogOpen && <WorkflowDialog onClose={() => setWorkflowDialogOpen(false)} />}
      {chatDialogOpen && <NewChatDialog onClose={() => setChatDialogOpen(false)} />}
    </div>
  );
}
