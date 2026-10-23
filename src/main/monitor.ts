import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { basename, dirname, sep } from 'node:path';
import type { AgentStatus, AgentStatusChange, RunDetail, RunSummary, Settings, Snapshot } from '../shared/types';
import { claudeHeader, codexHeader, discoverAll, loadRunDetail, type RunLocation } from './discovery';

export interface MonitorEvents {
  snapshot: [Snapshot];
  run: [RunDetail];
  'status-change': [AgentStatusChange[]];
}

const DEBOUNCE_MS = 250;
const MAX_DEBOUNCE_MS = 1_000;
const TICK_MS = 15_000;
const MAX_CACHED_DETAILS = 8;
const MAX_PARSE_ATTEMPTS = 2;

interface CachedDetail {
  detail: RunDetail;
  readAt: number;
}

interface PendingChange {
  timer: NodeJS.Timeout;
  firstAt: number;
}

/** Owns session discovery, bounded detail reads, and live filesystem updates. */
export class Monitor extends EventEmitter<MonitorEvents> {
  private runs = new Map<string, RunSummary>();
  private locations = new Map<string, RunLocation>();
  private runIdsByPath = new Map<string, string>();
  private sources: Snapshot['sources'] = [];
  private details = new Map<string, CachedDetail>();
  private loads = new Map<string, Promise<RunDetail | undefined>>();
  private refreshes = new Map<string, Promise<void>>();
  private revisions = new Map<string, number>();
  private agentStatuses = new Map<string, Map<string, AgentStatus>>();
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, PendingChange>();
  private tick: NodeJS.Timeout | undefined;
  private watchedRunId: string | undefined;
  private scanning: Promise<void> | undefined;
  private refreshing: Promise<void> | undefined;
  private stopped = false;
  /** Source changes and shutdown cancel old work; rescans only change freshness. */
  private generation = 0;
  private scanRevision = 0;

  constructor(private settings: Settings) {
    super();
  }

  async start(): Promise<void> {
    this.stopped = false;
    const generation = this.generation;
    await this.rescan();
    if (this.stopped || generation !== this.generation) return;
    this.startWatcher();
    this.tick = setInterval(() => void this.refreshActive(), TICK_MS);
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    void this.watcher?.close();
    this.watcher = undefined;
    if (this.tick) clearInterval(this.tick);
    this.tick = undefined;
    this.clearPending();
    this.details.clear();
    this.loads.clear();
    this.refreshes.clear();
    this.agentStatuses.clear();
    this.scanning = undefined;
    this.refreshing = undefined;
  }

  snapshot(): Snapshot {
    return { runs: [...this.runs.values()], sources: this.sources, scannedAt: Date.now() };
  }

  async rescan(): Promise<void> {
    if (this.stopped) return;
    if (this.scanning) return this.scanning;
    const generation = this.generation;
    this.scanRevision += 1;
    for (const id of this.details.keys()) this.markStale(id);
    const scanning = (async () => {
      const result = await discoverAll(this.settings);
      if (this.stopped || generation !== this.generation) return;
      const previous = this.runs;
      this.runs = new Map(result.runs.map((run) => [run.id, this.withPreviousTokens(run, previous.get(run.id), true)]));
      this.locations = result.locations;
      this.runIdsByPath = new Map([...result.locations.values()].map((location) => [location.filePath, location.id]));
      this.sources = result.sources;
      for (const id of this.details.keys()) if (!this.locations.has(id)) this.details.delete(id);
      for (const id of this.agentStatuses.keys()) if (!this.locations.has(id)) this.agentStatuses.delete(id);
      this.emit('snapshot', this.snapshot());
    })();
    this.scanning = scanning;
    try {
      await scanning;
    } finally {
      if (this.scanning === scanning) this.scanning = undefined;
    }
    // Finished runs are not visited by the status timer. Refresh the selected
    // transcript after discovery too, without making discovery wait on a read
    // that may itself be awaiting this scan.
    if (!this.stopped && generation === this.generation && this.watchedRunId && this.locations.has(this.watchedRunId)) {
      void this.refreshWatched().catch((error: unknown) => console.warn('[monitor] failed to refresh selected run after scan', error));
    }
  }

  async updateSettings(next: Settings): Promise<void> {
    const dirsChanged = next.claudeSessionsDir !== this.settings.claudeSessionsDir || next.codexSessionsDir !== this.settings.codexSessionsDir;
    const windowChanged = next.activeWindowSeconds !== this.settings.activeWindowSeconds;
    this.settings = next;
    if (dirsChanged) {
      this.generation += 1;
      const generation = this.generation;
      const watcher = this.watcher;
      this.watcher = undefined;
      this.details.clear();
      this.loads.clear();
      this.refreshes.clear();
      this.agentStatuses.clear();
      this.revisions.clear();
      this.clearPending();
      // Detach old discovery before the first await: requests arriving while the
      // watcher closes must wait for the new source index, not read old paths
      // using new settings. Generation guards prevent late old work publishing.
      this.scanning = undefined;
      this.refreshing = undefined;
      this.runs.clear();
      this.locations.clear();
      this.runIdsByPath.clear();
      await Promise.all([this.rescan(), watcher?.close()]);
      if (!this.stopped && generation === this.generation) this.startWatcher();
    } else if (windowChanged) {
      await this.rescan();
    }
  }

  /** Only the selected run is parsed eagerly. Background totals can be stale. */
  watchRun(runId: string | undefined): void {
    if (runId !== this.watchedRunId) this.agentStatuses.clear();
    this.watchedRunId = runId;
  }

  async loadRun(runId: string): Promise<RunDetail | undefined> {
    return this.readRun(runId);
  }

  async loadRunTokens(runId: string): Promise<RunSummary | undefined> {
    if (this.stopped) return undefined;
    const existing = this.runs.get(runId);
    // Do not re-arm the sidebar's lazy loader on every log write. Selecting the
    // run refreshes this explicitly labelled previous total.
    if (existing?.tokensLoaded) return existing;
    const detail = await this.readRun(runId);
    return detail ? this.runs.get(runId) : undefined;
  }

  private async readRun(runId: string, force = false): Promise<RunDetail | undefined> {
    if (this.stopped) return undefined;
    const cached = this.details.get(runId);
    if (!force && !this.scanning && cached && !cached.detail.stale && Date.now() - cached.readAt < TICK_MS) {
      this.cacheDetail(runId, cached);
      if (runId === this.watchedRunId) this.recordStatuses(cached.detail, false);
      return cached.detail;
    }
    const pending = this.loads.get(runId);
    if (pending) return pending;
    const promise = this.parseRun(runId, this.generation, cached?.detail);
    this.loads.set(runId, promise);
    try {
      return await promise;
    } finally {
      if (this.loads.get(runId) === promise) this.loads.delete(runId);
    }
  }

  /**
   * A busy writer must not starve a caller. At most two full parses are attempted;
   * then the latest completed snapshot is returned as stale without publishing
   * status transitions or pretending its tokens include the newest records.
   */
  private async parseRun(runId: string, generation: number, previous: RunDetail | undefined): Promise<RunDetail | undefined> {
    let completed = previous;
    let readAt = Date.now();
    let lastError: unknown;
    for (let attempt = 0; attempt < MAX_PARSE_ATTEMPTS; attempt += 1) {
      if (this.scanning) await this.scanning;
      if (this.stopped || generation !== this.generation) return undefined;
      const location = this.locations.get(runId);
      if (!location) return undefined;
      const scanRevision = this.scanRevision;
      const revision = this.revisions.get(runId) ?? 0;
      readAt = Date.now();
      try {
        completed = await loadRunDetail(location, this.settings, readAt);
        lastError = undefined;
      } catch (error) {
        if (this.stopped || generation !== this.generation) return undefined;
        const changed = scanRevision !== this.scanRevision || revision !== (this.revisions.get(runId) ?? 0) || location !== this.locations.get(runId);
        if (!changed) throw error;
        lastError = error;
        continue;
      }
      if (this.stopped || generation !== this.generation) return undefined;
      const fresh = !this.scanning && scanRevision === this.scanRevision && revision === (this.revisions.get(runId) ?? 0) && location === this.locations.get(runId);
      if (fresh) {
        const detail: RunDetail = { ...completed, stale: false, run: { ...completed.run, tokensStale: false } };
        this.cacheDetail(runId, { detail, readAt });
        if (runId === this.watchedRunId) this.recordStatuses(detail, true);
        this.mergeRunSummary(detail.run);
        return detail;
      }
    }
    // Let an in-progress rescan settle before deciding whether the session still exists.
    if (this.scanning) await this.scanning;
    if (this.stopped || generation !== this.generation || !this.locations.has(runId)) return undefined;
    if (!completed) throw lastError ?? new Error('The session changed while loading. Try again.');
    const stale: RunDetail = { ...completed, stale: true, run: { ...completed.run, tokensStale: true } };
    this.cacheDetail(runId, { detail: stale, readAt });
    const current = this.runs.get(runId);
    if (current && completed.run.tokens) {
      // Retain newer header/status metadata; only publish the explicitly stale total.
      this.mergeRunSummary({ ...current, tokens: completed.run.tokens, tokensLoaded: true, tokensStale: true });
    }
    return stale;
  }

  private cacheDetail(runId: string, cached: CachedDetail): void {
    this.details.delete(runId);
    this.details.set(runId, cached);
    for (const id of this.details.keys()) {
      if (this.details.size <= MAX_CACHED_DETAILS) break;
      if (id !== this.watchedRunId) this.details.delete(id);
    }
  }

  private markStale(runId: string): void {
    const cached = this.details.get(runId);
    if (cached && !cached.detail.stale) {
      this.details.set(runId, { ...cached, detail: { ...cached.detail, stale: true, run: { ...cached.detail.run, tokensStale: true } } });
    }
    const run = this.runs.get(runId);
    if (run?.tokensLoaded) this.runs.set(runId, { ...run, tokensStale: true });
  }

  private invalidateRun(runId: string): void {
    this.revisions.set(runId, (this.revisions.get(runId) ?? 0) + 1);
    this.markStale(runId);
  }

  private withPreviousTokens(run: RunSummary, previous: RunSummary | undefined, stale: boolean): RunSummary {
    return previous?.tokensLoaded && previous.tokens
      ? { ...run, tokens: previous.tokens, tokensLoaded: true, tokensStale: stale || previous.tokensStale === true }
      : run;
  }

  private mergeRunSummary(run: RunSummary): void {
    const previous = this.runs.get(run.id);
    this.runs.set(run.id, run);
    if (!previous || previous.status !== run.status || previous.title !== run.title || previous.tokensLoaded !== run.tokensLoaded || previous.tokensStale !== run.tokensStale || previous.agentCount !== run.agentCount || previous.lastActivityAt !== run.lastActivityAt
      || previous.tokens?.input !== run.tokens?.input || previous.tokens?.output !== run.tokens?.output || previous.tokens?.cacheRead !== run.tokens?.cacheRead || previous.tokens?.cacheWrite !== run.tokens?.cacheWrite) {
      this.emit('snapshot', this.snapshot());
    }
  }

  private recordStatuses(detail: RunDetail, notify: boolean): void {
    const previous = this.agentStatuses.get(detail.run.id);
    const next = new Map<string, AgentStatus>();
    const changes: AgentStatusChange[] = [];
    for (const agent of detail.agents) {
      next.set(agent.id, agent.status);
      const old = previous?.get(agent.id);
      if (notify && old && old !== agent.status && (agent.status === 'finished' || agent.status === 'errored')) {
        changes.push({ runId: detail.run.id, agentId: agent.id, title: agent.title, projectName: detail.run.projectName, from: old, to: agent.status });
      }
    }
    this.agentStatuses.set(detail.run.id, next);
    if (changes.length) this.emit('status-change', changes);
  }

  private clearPending(): void {
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.pending.clear();
  }

  private startWatcher(): void {
    const generation = this.generation;
    this.watcher = chokidar.watch([this.settings.claudeSessionsDir, this.settings.codexSessionsDir], {
      ignoreInitial: true,
      depth: 6,
      persistent: true,
      ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl') && !path.endsWith('.meta.json'),
    });
    const schedule = (path: string) => {
      if (this.stopped || generation !== this.generation) return;
      const { runId, provider } = this.runIdForPath(path);
      if (provider === 'codex' && !path.endsWith('.jsonl')) return;
      if (runId) this.invalidateRun(runId);
      const key = runId ?? path;
      const pending = this.pending.get(key);
      if (pending) clearTimeout(pending.timer);
      const firstAt = pending?.firstAt ?? Date.now();
      const delay = Math.min(DEBOUNCE_MS, Math.max(0, MAX_DEBOUNCE_MS - (Date.now() - firstAt)));
      const timer = setTimeout(() => {
        this.pending.delete(key);
        if (!this.stopped && generation === this.generation) void this.handleChange(path).catch((error: unknown) => console.warn('[monitor] failed to refresh', path, error));
      }, delay);
      this.pending.set(key, { timer, firstAt });
    };
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', (path) => {
      if (!this.stopped && generation === this.generation) void this.handleRemove(path).catch((error: unknown) => console.warn('[monitor] failed to remove', path, error));
    });
    this.watcher.on('error', (error) => console.warn('[monitor] watcher error', error));
  }

  private runIdForPath(path: string): { runId: string | undefined; provider: 'claude' | 'codex' } {
    const codexDir = this.settings.codexSessionsDir;
    if (path.startsWith(codexDir + sep) || path.startsWith(codexDir + '/')) {
      return { runId: this.runIdsByPath.get(path), provider: 'codex' };
    }
    const name = basename(path);
    if (name.endsWith('.jsonl') && !name.startsWith('agent-')) return { runId: name.slice(0, -'.jsonl'.length), provider: 'claude' };
    const parent = dirname(path);
    if (basename(parent) === 'subagents') return { runId: basename(dirname(parent)), provider: 'claude' };
    return { runId: undefined, provider: 'claude' };
  }

  private async refreshWatched(force = false): Promise<void> {
    const id = this.watchedRunId;
    if (!id) return;
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const generation = this.generation;
    const refresh = (async () => {
      const detail = await this.readRun(id, force);
      if (detail && this.watchedRunId === id && !this.stopped && generation === this.generation && this.locations.has(id)) this.emit('run', detail);
    })();
    this.refreshes.set(id, refresh);
    try {
      await refresh;
    } finally {
      if (this.refreshes.get(id) === refresh) this.refreshes.delete(id);
    }
  }

  private async handleChange(path: string): Promise<void> {
    const generation = this.generation;
    if (this.scanning) await this.scanning;
    if (this.stopped || generation !== this.generation) return;
    const { runId, provider } = this.runIdForPath(path);
    const location = runId ? this.locations.get(runId) : undefined;
    if (!location) {
      const mainPath = provider === 'claude' && basename(dirname(path)) === 'subagents' ? dirname(dirname(path)) + '.jsonl' : path;
      if (!mainPath.endsWith('.jsonl')) return;
      const scanRevision = this.scanRevision;
      const header = provider === 'codex' ? await codexHeader(mainPath, this.settings) : await claudeHeader(mainPath, this.settings);
      if (!header || this.stopped || generation !== this.generation || scanRevision !== this.scanRevision) return;
      this.locations.set(header.location.id, header.location);
      this.runIdsByPath.set(header.location.filePath, header.location.id);
      this.runs.set(header.run.id, header.run);
      this.emit('snapshot', this.snapshot());
      return;
    }
    if (location.id === this.watchedRunId) {
      await this.refreshWatched();
      return;
    }
    const scanRevision = this.scanRevision;
    const revision = this.revisions.get(location.id);
    const header = location.provider === 'codex' ? await codexHeader(location.filePath, this.settings) : await claudeHeader(location.filePath, this.settings);
    if (!header || this.stopped || generation !== this.generation || scanRevision !== this.scanRevision || revision !== this.revisions.get(location.id) || this.locations.get(location.id) !== location) return;
    const previous = this.runs.get(location.id);
    const cached = this.details.get(location.id)?.detail;
    const next = cached && !cached.stale ? cached.run : this.withPreviousTokens(header.run, previous, true);
    this.runs.set(location.id, next);
    this.emit('snapshot', this.snapshot());
    this.notifyRunStatus(previous, next);
  }

  private async handleRemove(path: string): Promise<void> {
    const generation = this.generation;
    const before = this.runIdForPath(path);
    if (before.runId) this.invalidateRun(before.runId);
    if (this.scanning) await this.scanning;
    if (this.stopped || generation !== this.generation) return;
    const runId = this.runIdForPath(path).runId ?? before.runId;
    if (!runId) return;
    const location = this.locations.get(runId);
    if (location?.filePath === path) {
      const pending = this.pending.get(runId);
      if (pending) clearTimeout(pending.timer);
      this.pending.delete(runId);
      this.locations.delete(runId);
      this.runIdsByPath.delete(path);
      this.runs.delete(runId);
      this.details.delete(runId);
      this.agentStatuses.delete(runId);
      this.emit('snapshot', this.snapshot());
    } else if (location && before.provider === 'claude' && basename(dirname(path)) === 'subagents') {
      // Child transcripts and metadata affect the parent's count, labels and tree.
      await this.handleChange(path);
    }
  }

  private notifyRunStatus(previous: RunSummary | undefined, next: RunSummary): void {
    if (previous && previous.status !== next.status && (next.status === 'finished' || next.status === 'errored')) {
      this.emit('status-change', [{ runId: next.id, agentId: next.id, title: next.title, projectName: next.projectName, from: previous.status, to: next.status }]);
    }
  }

  /** Refresh wall-clock status even after an idle run passes the active window. */
  private async refreshActive(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    const generation = this.generation;
    const scanRevision = this.scanRevision;
    const refreshing = (async () => {
      const now = Date.now();
      const active = [...this.runs.values()].filter((run) => run.status === 'running' || (run.status === 'idle' && run.lastActivityAt !== undefined));
      for (const run of active) {
        if (this.stopped || generation !== this.generation || scanRevision !== this.scanRevision) return;
        const location = this.locations.get(run.id);
        if (!location) continue;
        if (run.id === this.watchedRunId) {
          await this.refreshWatched(true);
          continue;
        }
        const revision = this.revisions.get(run.id);
        const header = location.provider === 'codex' ? await codexHeader(location.filePath, this.settings, now) : await claudeHeader(location.filePath, this.settings, now);
        if (!header || this.stopped || generation !== this.generation || scanRevision !== this.scanRevision || revision !== this.revisions.get(run.id) || location !== this.locations.get(run.id)) continue;
        const previous = this.runs.get(run.id);
        if (previous?.status !== header.run.status) {
          const cached = this.details.get(run.id);
          if (cached) this.details.set(run.id, { ...cached, detail: { ...cached.detail, stale: true } });
          const next = this.withPreviousTokens(header.run, previous, false);
          this.mergeRunSummary(next);
          this.notifyRunStatus(previous, next);
        }
      }
    })();
    this.refreshing = refreshing;
    try {
      await refreshing;
    } catch (error) {
      console.warn('[monitor] failed to refresh active runs', error);
    } finally {
      if (this.refreshing === refreshing) this.refreshing = undefined;
    }
  }
}
