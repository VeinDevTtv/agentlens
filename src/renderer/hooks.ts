import { useEffect } from 'react';
import { bridge } from './lib/bridge';
import { loadSelectedRun, preferLiveDetail } from './lib/load-selected-run';
import { useStore } from './store';

/** Wire the preload bridge into the store: initial snapshot, live updates, settings. */
export function useMonitor(): void {
  const setSnapshot = useStore((s) => s.setSnapshot);
  const setSnapshotError = useStore((s) => s.setSnapshotError);
  const setDetail = useStore((s) => s.setDetail);
  const setSettings = useStore((s) => s.setSettings);
  const setWorkflows = useStore((s) => s.setWorkflows);
  const upsertWorkflow = useStore((s) => s.upsertWorkflow);
  const setOrchestratorConfig = useStore((s) => s.setOrchestratorConfig);
  const setChats = useStore((s) => s.setChats);
  const upsertChat = useStore((s) => s.upsertChat);

  useEffect(() => {
    const api = bridge();
    if (!api) {
      setSnapshotError('The desktop bridge is unavailable. Run the app with `npm run dev`, not in a plain browser tab.');
      return;
    }
    let cancelled = false;
    void api.getSettings().then((settings) => !cancelled && setSettings(settings));
    void api
      .getSnapshot()
      .then((snapshot) => !cancelled && setSnapshot(snapshot))
      .catch((error: unknown) => !cancelled && setSnapshotError(error instanceof Error ? error.message : String(error)));
    void api
      .listWorkflows()
      .then((workflows) => !cancelled && setWorkflows(workflows))
      .catch(() => undefined);
    void api
      .getOrchestratorConfig()
      .then((config) => !cancelled && setOrchestratorConfig(config))
      .catch(() => undefined);
    void api
      .listChats()
      .then((chats) => !cancelled && setChats(chats))
      .catch(() => undefined);
    const offSnapshot = api.onSnapshot((snapshot) => setSnapshot(snapshot));
    const offRun = api.onRunUpdate((detail) => setDetail(detail));
    const offWorkflow = api.onWorkflowUpdate((workflow) => upsertWorkflow(workflow));
    const offChat = api.onChatUpdate((chat) => upsertChat(chat));
    return () => {
      cancelled = true;
      offSnapshot();
      offRun();
      offWorkflow();
      offChat();
    };
  }, [setSnapshot, setSnapshotError, setDetail, setSettings, setWorkflows, upsertWorkflow, setOrchestratorConfig, setChats, upsertChat]);
}

/** Load the selected run's detail and tell the main process to keep it fresh. */
export function useSelectedRun(): void {
  const selectedRunId = useStore((s) => s.selectedRunId);
  const detailRequestVersion = useStore((s) => s.detailRequestVersion);
  const setDetail = useStore((s) => s.setDetail);
  const setDetailLoading = useStore((s) => s.setDetailLoading);
  const setDetailError = useStore((s) => s.setDetailError);
  const mergeRun = useStore((s) => s.mergeRun);

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    void api.watchRun(selectedRunId).catch(() => undefined);
    if (!selectedRunId) return;
    let cancelled = false;
    const detailAtStart = useStore.getState().details[selectedRunId];
    setDetailLoading(true);
    setDetailError(undefined);
    void loadSelectedRun(api, selectedRunId, () => !cancelled)
      .then((detail) => {
        if (cancelled) return;
        const current = useStore.getState().details[selectedRunId];
        if (preferLiveDetail(current, detailAtStart, detail)) {
          setDetailLoading(false);
          return;
        }
        if (detail) {
          setDetail(detail);
          // The main process keeps newer header metadata when a busy log forces
          // a stale fallback. Do not replace that snapshot with the older parse.
          if (!detail.stale) mergeRun(detail.run);
        } else {
          setDetailLoading(false);
          setDetailError('This run is no longer available in the configured session directories. Choose another run or check Settings.');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDetailLoading(false);
        // A successful live update can arrive while an older IPC request fails.
        if (preferLiveDetail(useStore.getState().details[selectedRunId], detailAtStart, undefined)) return;
        setDetailError(error instanceof Error ? error.message : 'Could not read this run. Retry or check the session directory in Settings.');
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, detailRequestVersion, setDetail, setDetailLoading, setDetailError, mergeRun]);
}

/** Keep relative times and elapsed counters moving. */
export function useClock(intervalMs = 1000): void {
  const tickNow = useStore((s) => s.tickNow);
  useEffect(() => {
    const timer = setInterval(tickNow, intervalMs);
    return () => clearInterval(timer);
  }, [tickNow, intervalMs]);
}

/** Apply the theme preference to <html data-theme>. */
export function useTheme(): void {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

/** Global keyboard shortcuts. Ignored while typing in a field, except Escape. */
export function useKeyboardShortcuts(orderedRunIds: () => string[]): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const state = useStore.getState();
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
      const dialogOpen = state.settingsOpen || state.helpOpen || state.workflowDialogOpen || state.chatDialogOpen;

      if (event.key === 'Escape') {
        if (state.helpOpen) state.setHelpOpen(false);
        else if (state.settingsOpen) state.setSettingsOpen(false);
        else if (state.workflowDialogOpen) state.setWorkflowDialogOpen(false);
        else if (state.chatDialogOpen) state.setChatDialogOpen(false);
        else if (state.selectedAgentId) state.selectAgent(undefined);
        else if (typing) (target as HTMLInputElement).blur();
        else if (state.search) state.setSearch('');
        return;
      }
      if (typing || dialogOpen || event.metaKey || event.ctrlKey || event.altKey) return;

      switch (event.key) {
        case '/':
          event.preventDefault();
          document.getElementById('run-search')?.focus();
          break;
        case '?':
          event.preventDefault();
          state.setHelpOpen(true);
          break;
        case ',':
          event.preventDefault();
          state.setSettingsOpen(true);
          break;
        case 'n':
          event.preventDefault();
          state.setWorkflowDialogOpen(true);
          break;
        case 'c':
          event.preventDefault();
          state.setChatDialogOpen(true);
          break;
        case 'j':
        case 'k': {
          event.preventDefault();
          const ids = orderedRunIds();
          if (!ids.length) return;
          const index = state.selectedRunId ? ids.indexOf(state.selectedRunId) : -1;
          const next = event.key === 'j' ? Math.min(ids.length - 1, index + 1) : Math.max(0, index <= 0 ? 0 : index - 1);
          const id = ids[next];
          if (id) {
            state.selectRun(id);
            document.querySelector<HTMLElement>(`[data-run-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
          }
          break;
        }
        case 'Enter': {
          const detail = state.selectedRunId ? state.details[state.selectedRunId] : undefined;
          const main = detail?.agents.find((a) => a.role === 'main') ?? detail?.agents[0];
          if (main) state.selectAgent(main.id);
          break;
        }
        case '1':
          state.setView('topology');
          break;
        case '2':
          state.setView('timeline');
          break;
        case '[':
          state.toggleSidebar();
          break;
        case 'a':
          state.toggleActiveOnly();
          break;
        case 'r':
          void bridge()?.rescan();
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [orderedRunIds]);
}

/** Desktop notifications for finish/error transitions, when enabled in Settings. */
export function useNotifications(): void {
  useEffect(() => {
    const api = bridge();
    if (!api) return;
    return api.onStatusChange((changes) => {
      const state = useStore.getState();
      if (!state.settings.notifications || typeof Notification === 'undefined' || Notification.permission === 'denied') return;
      for (const change of changes.slice(0, 3)) {
        const title = change.to === 'errored' ? `Agent errored · ${change.projectName}` : `Agent finished · ${change.projectName}`;
        const notification = new Notification(title, { body: change.title, silent: change.to !== 'errored', tag: `${change.runId}:${change.agentId}` });
        notification.onclick = () => {
          const current = useStore.getState();
          current.selectRun(change.runId);
          if (change.agentId !== change.runId) setTimeout(() => useStore.getState().selectAgent(change.agentId), 400);
        };
      }
    });
  }, []);
}
