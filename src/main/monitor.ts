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
        // Keep lazily loaded tokens across rescans when the file did not change.
        this.runs.set(run.id, old?.tokensLoaded && old.lastActivityAt === run.lastActivityAt && old.tokens ? { ...run, tokens: old.tokens, tokensLoaded: true } : run);
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
    this.watchedRunId = runId;
  }

  async loadRun(runId: string): Promise<RunDetail | undefined> {
    const location = this.locations.get(runId);
    if (!location) return undefined;
    const detail = await loadRunDetail(location, this.settings);
    this.details.set(runId, detail);
    this.recordStatuses(detail, false);
    this.mergeRunSummary(detail.run);
    return detail;
  }

  async loadRunTokens(runId: string): Promise<RunSummary | undefined> {
    const existing = this.runs.get(runId);
    if (existing?.tokensLoaded) return existing;
    const detail = this.details.get(runId) ?? (await this.loadRun(runId));
    return detail ? this.runs.get(runId) : undefined;
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
      for (const location of this.locations.values()) if (location.filePath === path) return { runId: location.id, provider: 'codex' };
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
      const header = provider === 'codex' ? await codexHeader(path, this.settings) : await claudeHeader(path, this.settings);
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
    const header = location.provider === 'codex' ? await codexHeader(location.filePath, this.settings) : await claudeHeader(location.filePath, this.settings);
    if (!header) return;
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
    const { runId } = this.runIdForPath(path);
    if (!runId || !path.endsWith('.jsonl') || basename(path).startsWith('agent-')) return;
    const location = this.locations.get(runId);
    if (location && location.filePath === path) {
      this.locations.delete(runId);
      this.runs.delete(runId);
      this.details.delete(runId);
      this.emit('snapshot', this.snapshot());
    }
  }

  /** Statuses depend on wall-clock time, so re-derive runs that were recently active. */
  private async refreshActive(): Promise<void> {
    const window = this.settings.activeWindowSeconds * 1000 * 2;
    const now = Date.now();
    const stale = [...this.runs.values()].filter((r) => r.status === 'running' || (r.lastActivityAt !== undefined && now - r.lastActivityAt < window));
    let changed = false;
    for (const run of stale) {
      const location = this.locations.get(run.id);
      if (!location) continue;
      if (location.id === this.watchedRunId) {
        try {
          const detail = await loadRunDetail(location, this.settings, now);
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
      const header = location.provider === 'codex' ? await codexHeader(location.filePath, this.settings, now) : await claudeHeader(location.filePath, this.settings, now);
      if (header && header.run.status !== run.status) {
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
