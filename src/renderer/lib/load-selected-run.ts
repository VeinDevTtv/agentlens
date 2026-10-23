import type { RunDetail } from '../../shared/types';

interface RunReader {
  loadRun(runId: string): Promise<RunDetail | undefined>;
  rescan(): Promise<void>;
}

/** Retry a transient discovery miss once, without continuing after selection changes. */
export async function loadSelectedRun(api: RunReader, runId: string, isCurrent: () => boolean): Promise<RunDetail | undefined> {
  if (!isCurrent()) return undefined;
  const detail = await api.loadRun(runId);
  if (detail || !isCurrent()) return detail;
  await api.rescan();
  return isCurrent() ? api.loadRun(runId) : undefined;
}

/** A live update received during a request must not be replaced by its older reply. */
export function preferLiveDetail(current: RunDetail | undefined, atStart: RunDetail | undefined, loaded: RunDetail | undefined): boolean {
  if (!current || current === atStart) return false;
  if (!loaded) return true;
  const currentActivity = current.run.lastActivityAt ?? 0;
  const loadedActivity = loaded.run.lastActivityAt ?? 0;
  if (currentActivity !== loadedActivity) return currentActivity > loadedActivity;
  if (!!current.stale !== !!loaded.stale) return !current.stale;
  return true;
}
