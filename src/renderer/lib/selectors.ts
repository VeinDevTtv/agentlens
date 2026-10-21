import type { ProjectGroup, RunSummary } from '../../shared/types';
import type { UiState } from '../store';

export function matchesFilters(run: RunSummary, state: Pick<UiState, 'search' | 'projectFilter' | 'statusFilter' | 'providerFilter' | 'activeOnly' | 'showEmpty'>): boolean {
  if (!state.showEmpty && run.isEmpty) return false;
  if (state.activeOnly && run.status !== 'running') return false;
  if (state.statusFilter !== 'all' && run.status !== state.statusFilter) return false;
  if (state.providerFilter !== 'all' && run.provider !== state.providerFilter) return false;
  if (state.projectFilter !== 'all' && run.projectName !== state.projectFilter) return false;
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    const haystack = `${run.title} ${run.projectName} ${run.cwd} ${run.gitBranch ?? ''} ${run.model ?? ''} ${run.id}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

export function sortRuns(a: RunSummary, b: RunSummary): number {
  return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
}

export function groupByProject(runs: RunSummary[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const run of runs) {
    const group = groups.get(run.projectName) ?? { name: run.projectName, path: run.projectPath, runIds: [], runningCount: 0 };
    group.runIds.push(run.id);
    if (run.status === 'running') group.runningCount += 1;
    if (run.lastActivityAt !== undefined && (group.lastActivityAt === undefined || run.lastActivityAt > group.lastActivityAt)) group.lastActivityAt = run.lastActivityAt;
    groups.set(run.projectName, group);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.runningCount !== b.runningCount) return b.runningCount - a.runningCount;
    return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
  });
}

export function projectNames(runs: RunSummary[]): string[] {
  return [...new Set(runs.map((r) => r.projectName))].sort((a, b) => a.localeCompare(b));
}
