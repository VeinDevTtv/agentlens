import { create } from 'zustand';
import { DEFAULT_PRICING } from '../core/pricing';
import type { AgentStatus, Provider, RunDetail, RunSummary, Settings, Snapshot } from '../shared/types';

export type StatusFilter = 'all' | AgentStatus;
export type ProviderFilter = 'all' | Provider;
export type View = 'topology' | 'timeline';

export interface UiState {
  snapshot: Snapshot | undefined;
  snapshotError: string | undefined;
  loading: boolean;
  selectedRunId: string | undefined;
  selectedAgentId: string | undefined;
  details: Record<string, RunDetail>;
  detailLoading: boolean;
  search: string;
  projectFilter: string | 'all';
  statusFilter: StatusFilter;
  providerFilter: ProviderFilter;
  activeOnly: boolean;
  showEmpty: boolean;
  collapsedProjects: Record<string, boolean>;
  view: View;
  settings: Settings;
  settingsOpen: boolean;
  helpOpen: boolean;
  sidebarCollapsed: boolean;
  now: number;
}

export interface UiActions {
  setSnapshot(snapshot: Snapshot): void;
  setSnapshotError(error: string | undefined): void;
  setLoading(loading: boolean): void;
  selectRun(runId: string | undefined): void;
  selectAgent(agentId: string | undefined): void;
  setDetail(detail: RunDetail): void;
  setDetailLoading(loading: boolean): void;
  mergeRun(run: RunSummary): void;
  setSearch(search: string): void;
  setProjectFilter(project: string | 'all'): void;
  setStatusFilter(status: StatusFilter): void;
  setProviderFilter(provider: ProviderFilter): void;
  toggleActiveOnly(): void;
  toggleShowEmpty(): void;
  toggleProject(name: string): void;
  setView(view: View): void;
  setSettings(settings: Settings): void;
  setSettingsOpen(open: boolean): void;
  setHelpOpen(open: boolean): void;
  toggleSidebar(): void;
  tickNow(): void;
}

export const DEFAULT_SETTINGS: Settings = {
  claudeSessionsDir: '~/.claude/projects',
  codexSessionsDir: '~/.codex/sessions',
  theme: 'system',
  notifications: false,
  activeWindowSeconds: 45,
  pricing: { ...DEFAULT_PRICING },
};

export const useStore = create<UiState & UiActions>((set) => ({
  snapshot: undefined,
  snapshotError: undefined,
  loading: true,
  selectedRunId: undefined,
  selectedAgentId: undefined,
  details: {},
  detailLoading: false,
  search: '',
  projectFilter: 'all',
  statusFilter: 'all',
  providerFilter: 'all',
  activeOnly: false,
  showEmpty: false,
  collapsedProjects: {},
  view: 'topology',
  settings: DEFAULT_SETTINGS,
  settingsOpen: false,
  helpOpen: false,
  sidebarCollapsed: false,
  now: Date.now(),

  setSnapshot: (snapshot) => set({ snapshot, loading: false, snapshotError: undefined }),
  setSnapshotError: (snapshotError) => set({ snapshotError, loading: false }),
  setLoading: (loading) => set({ loading }),
  selectRun: (selectedRunId) => set({ selectedRunId, selectedAgentId: undefined }),
  selectAgent: (selectedAgentId) => set({ selectedAgentId }),
  setDetail: (detail) => set((state) => ({ details: { ...state.details, [detail.run.id]: detail }, detailLoading: false })),
  setDetailLoading: (detailLoading) => set({ detailLoading }),
  mergeRun: (run) =>
    set((state) => {
      if (!state.snapshot) return {};
      return { snapshot: { ...state.snapshot, runs: state.snapshot.runs.map((r) => (r.id === run.id ? run : r)) } };
    }),
  setSearch: (search) => set({ search }),
  setProjectFilter: (projectFilter) => set({ projectFilter }),
  setStatusFilter: (statusFilter) => set({ statusFilter }),
  setProviderFilter: (providerFilter) => set({ providerFilter }),
  toggleActiveOnly: () => set((s) => ({ activeOnly: !s.activeOnly })),
  toggleShowEmpty: () => set((s) => ({ showEmpty: !s.showEmpty })),
  toggleProject: (name) => set((s) => ({ collapsedProjects: { ...s.collapsedProjects, [name]: !s.collapsedProjects[name] } })),
  setView: (view) => set({ view }),
  setSettings: (settings) => set({ settings }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setHelpOpen: (helpOpen) => set({ helpOpen }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  tickNow: () => set({ now: Date.now() }),
}));
