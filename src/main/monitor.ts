import chokidar, { type FSWatcher } from 'chokidar';
import { EventEmitter } from 'node:events';
import { basename, dirname, sep } from 'node:path';
import type { AgentStatus, AgentStatusChange, RunDetail, RunSummary, Settings, Snapshot } from '../shared/types';
import { claudeHeader, codexRunHeader, discoverAll, loadRunDetail, type RunLocation } from './discovery';

export interface MonitorEvents {
  snapshot: [Snapshot];
  run: [RunDetail];
  'status-change': [AgentStatusChange[]];
}

const DEBOUNCE_MS = 250;
const TICK_MS = 15_000;

/**
 * Owns the discovered runs, watches the session directories, and republishes
 * snapshots and run details as log files change.
 */
export class Monitor extends EventEmitter<MonitorEvents> {
  private runs = new Map<string, RunSummary>();
  private locations = new Map<string, RunLocation>();
  private sources: Snapshot['sources'] = [];
  private details = new Map<string, RunDetail>();
  private agentStatuses = new Map<string, Map<string, AgentStatus>>();
  private watcher: FSWatcher | undefined;
  private pending = new Map<string, NodeJS.Timeout>();
  private tick: NodeJS.Timeout | undefined;
  private watchedRunId: string | undefined;
  private scanning: Promise<void> | undefined;
  private codexScanning: Promise<void> | undefined;
  private codexRescanRequested = false;

  constructor(private settings: Settings) {
    super();
  }

  async start(): Promise<void> {
    await this.rescan();
    this.startWatcher();
    this.tick = setInterval(() => void this.refreshActive(), TICK_MS);
  }

  stop(): void {
    void this.watcher?.close();
    if (this.tick) clearInterval(this.tick);
    for (const timer of this.pending.values()) clearTimeout(timer);
  }

  snapshot(): Snapshot {
    return { runs: [...this.runs.values()], sources: this.sources, scannedAt: Date.now() };
  }

  async rescan(): Promise<void> {
    if (this.scanning) return this.scanning;
    this.scanning = (async () => {
      const result = await discoverAll(this.settings);
      const previous = this.runs;
      this.runs = new Map();
      for (const run of result.runs) {
        const old = previous.get(run.id);
        // Codex membership can change without changing the latest timestamp, so
        // its totals must be reloaded after rediscovering the tree.
        this.runs.set(run.id, run.provider !== 'codex' && old?.tokensLoaded && old.lastActivityAt === run.lastActivityAt && old.tokens ? { ...run, tokens: old.tokens, tokensLoaded: true } : run);
      }
      this.locations = result.locations;
      this.sources = result.sources;
      this.details.clear();
      this.emit('snapshot', this.snapshot());
    })();
    try {
      await this.scanning;
    } finally {
      this.scanning = undefined;
    }
  }

  async updateSettings(next: Settings): Promise<void> {
    const dirsChanged = next.claudeSessionsDir !== this.settings.claudeSessionsDir || next.codexSessionsDir !== this.settings.codexSessionsDir;
    const windowChanged = next.activeWindowSeconds !== this.settings.activeWindowSeconds;
    this.settings = next;
    if (dirsChanged) {
      void this.watcher?.close();
      await this.rescan();
      this.startWatcher();
    } else if (windowChanged) {
      await this.rescan();
    }
  }

  /** The renderer tells us which run is open so we re-parse it eagerly on change. */
  watchRun(runId: string | undefined): void {
    this.watchedRunId = runId === undefined ? undefined : this.rootRunId(runId);
  }

  async loadRun(runId: string): Promise<RunDetail | undefined> {
    const { claudeSessionsDir, codexSessionsDir } = this.settings;
    const sameSources = () => this.settings.claudeSessionsDir === claudeSessionsDir && this.settings.codexSessionsDir === codexSessionsDir;
    // A public rescan can replace the graph while the first transcript read is
    // in flight. Retry its current location once, without reviving removed runs
    // or carrying a request across a change of configured session directories.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.scanning) await this.scanning;
      if (!sameSources()) return undefined;
      const location = this.locations.get(this.rootRunId(runId));
      if (!location) return undefined;
      let detail: RunDetail;
      try {
        detail = await loadRunDetail(location, this.settings);
      } catch (error) {
        if (this.scanning) await this.scanning;
        if (!sameSources()) return undefined;
        if (!this.locationIsCurrent(location)) continue;
        throw error;
      }
      if (this.scanning) await this.scanning;
      if (!sameSources()) return undefined;
      if (this.scanning || !this.locationIsCurrent(location)) continue;
      this.details.set(location.id, detail);
      this.recordStatuses(detail, false);
      this.mergeRunSummary(detail.run);
      return detail;
    }
    return undefined;
  }

  async loadRunTokens(runId: string): Promise<RunSummary | undefined> {
    runId = this.rootRunId(runId);
    const existing = this.runs.get(runId);
    if (existing?.tokensLoaded) return existing;
    const detail = this.details.get(runId) ?? (await this.loadRun(runId));
    return detail ? this.runs.get(detail.run.id) : undefined;
  }

  private rootRunId(runId: string): string {
    return this.locations.get(runId)?.rootRunId ?? runId;
  }

  private locationIsCurrent(location: RunLocation): boolean {
    const current = this.locations.get(location.id);
    // Codex location identity includes the discovered descendant list. A tree
    // rescan does not invalidate an unrelated Claude file at the same path.
    return current === location || (location.provider === 'claude' && current?.provider === 'claude' && current.filePath === location.filePath);
  }

  private mergeRunSummary(run: RunSummary): void {
    const previous = this.runs.get(run.id);
    this.runs.set(run.id, run);
    if (!previous || previous.status !== run.status || previous.title !== run.title || previous.tokensLoaded !== run.tokensLoaded || previous.agentCount !== run.agentCount) {
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

  private startWatcher(): void {
    const paths = [this.settings.claudeSessionsDir, this.settings.codexSessionsDir];
    this.watcher = chokidar.watch(paths, {
      ignoreInitial: true,
      depth: 5,
      persistent: true,
      ignored: (path, stats) => !!stats?.isFile() && !path.endsWith('.jsonl') && !path.endsWith('.meta.json'),
    });
    const schedule = (path: string) => {
      const existing = this.pending.get(path);
      if (existing) clearTimeout(existing);
      this.pending.set(
        path,
        setTimeout(() => {
          this.pending.delete(path);
          void this.handleChange(path);
        }, DEBOUNCE_MS),
      );
    };
    this.watcher.on('add', schedule).on('change', schedule).on('unlink', (path) => void this.handleRemove(path));
    this.watcher.on('error', (error) => console.warn('[monitor] watcher error', error));
  }

  private runIdForPath(path: string): { runId: string | undefined; provider: 'claude' | 'codex' } {
    const codexDir = this.settings.codexSessionsDir;
    if (path.startsWith(codexDir + sep) || path.startsWith(codexDir + '/')) {
      for (const location of this.locations.values()) if (location.filePath === path) return { runId: location.rootRunId ?? location.id, provider: 'codex' };
      return { runId: undefined, provider: 'codex' };
    }
    // <projects>/<proj>/<sid>.jsonl or <projects>/<proj>/<sid>/subagents/agent-x.(jsonl|meta.json)
    const name = basename(path);
    if (name.endsWith('.jsonl') && !name.startsWith('agent-')) return { runId: name.slice(0, -'.jsonl'.length), provider: 'claude' };
    const parent = dirname(path);
    if (basename(parent) === 'subagents') return { runId: basename(dirname(parent)), provider: 'claude' };
    return { runId: undefined, provider: 'claude' };
  }

  private async handleChange(path: string): Promise<void> {
    const { runId, provider } = this.runIdForPath(path);
    let location = runId ? this.locations.get(runId) : undefined;
    if (!location) {
      // New session file.
      if (!path.endsWith('.jsonl')) return;
      if (provider === 'codex') {
        await this.rescanCodexTrees();
        return;
      }
      const header = await claudeHeader(path, this.settings);
      if (!header) return;
      location = header.location;
      this.locations.set(location.id, location);
      this.runs.set(header.run.id, header.run);
      this.emit('snapshot', this.snapshot());
      return;
    }
    if (location.id === this.watchedRunId || this.details.has(location.id)) {
      try {
        const detail = await loadRunDetail(location, this.settings);
        if (!this.locationIsCurrent(location)) return;
        this.details.set(location.id, detail);
        this.recordStatuses(detail, true);
        this.runs.set(location.id, detail.run);
        this.emit('run', detail);
        this.emit('snapshot', this.snapshot());
      } catch (error) {
        console.warn('[monitor] failed to reload run', location.id, error);
      }
      return;
    }
    const header = location.provider === 'codex' ? await codexRunHeader(location, this.settings) : await claudeHeader(location.filePath, this.settings);
    if (!header || !this.locationIsCurrent(location)) return;
    const previous = this.runs.get(location.id);
    const changes: AgentStatusChange[] = [];
    if (previous && previous.status !== header.run.status && (header.run.status === 'finished' || header.run.status === 'errored')) {
      changes.push({ runId: location.id, agentId: location.id, title: header.run.title, projectName: header.run.projectName, from: previous.status, to: header.run.status });
    }
    this.runs.set(location.id, header.run);
    this.emit('snapshot', this.snapshot());
    if (changes.length) this.emit('status-change', changes);
  }

  private async handleRemove(path: string): Promise<void> {
    const pending = this.pending.get(path);
    if (pending) clearTimeout(pending);
    this.pending.delete(path);
    const { runId, provider } = this.runIdForPath(path);
    if (!path.endsWith('.jsonl')) return;
    if (provider === 'codex') {
      await this.rescanCodexTrees();
      return;
    }
    if (!runId || basename(path).startsWith('agent-')) return;
    const location = this.locations.get(runId);
    if (location && location.filePath === path) {
      this.locations.delete(runId);
      this.runs.delete(runId);
      this.details.delete(runId);
      this.emit('snapshot', this.snapshot());
    }
  }

  /** Adding/removing a rollout changes ancestry, including orphan promotion. */
  private async rescanCodexTrees(): Promise<void> {
    this.codexRescanRequested = true;
    if (this.codexScanning) return this.codexScanning;
    this.codexScanning = (async () => {
      do {
        this.codexRescanRequested = false;
        // A scan already in progress may have listed the directory before this
        // event. Follow it with one scan that includes the new tree membership.
        if (this.scanning) await this.scanning;
        await this.rescan();
        if (this.watchedRunId) {
          this.watchedRunId = this.rootRunId(this.watchedRunId);
          const watched = this.locations.get(this.watchedRunId);
          if (watched?.provider === 'codex') await this.handleChange(watched.filePath);
        }
      } while (this.codexRescanRequested);
    })();
    try {
      await this.codexScanning;
    } finally {
      this.codexScanning = undefined;
    }
  }

  /** Statuses depend on wall-clock time, so re-derive runs that were recently active. */
  private async refreshActive(): Promise<void> {
    const window = this.settings.activeWindowSeconds * 1000 * 2;
    const now = Date.now();
    const stale = [...this.runs.values()].filter((r) => r.status === 'running' || (r.lastActivityAt !== undefined && (now - r.lastActivityAt < window || (r.provider === 'codex' && r.status === 'idle'))));
    let changed = false;
    for (const run of stale) {
      const location = this.locations.get(run.id);
      if (!location) continue;
      if (location.id === this.watchedRunId) {
        try {
          const detail = await loadRunDetail(location, this.settings, now);
          if (!this.locationIsCurrent(location)) continue;
          this.details.set(location.id, detail);
          this.recordStatuses(detail, true);
          if (this.runs.get(run.id)?.status !== detail.run.status) changed = true;
          this.runs.set(run.id, detail.run);
          this.emit('run', detail);
        } catch {
          /* ignore */
        }
        continue;
      }
      const header = location.provider === 'codex' ? await codexRunHeader(location, this.settings, now) : await claudeHeader(location.filePath, this.settings, now);
      if (header && this.locationIsCurrent(location) && header.run.status !== run.status) {
        this.runs.set(run.id, { ...header.run, ...(run.tokensLoaded && run.tokens ? { tokens: run.tokens, tokensLoaded: true } : {}) });
        changed = true;
        if (header.run.status === 'finished' || header.run.status === 'errored') {
          this.emit('status-change', [{ runId: run.id, agentId: run.id, title: run.title, projectName: run.projectName, from: run.status, to: header.run.status }]);
        }
      }
    }
    if (changed) this.emit('snapshot', this.snapshot());
  }
}
