import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { codexParentMap, mergeCodexSessions, parseClaudeHeader, parseClaudeSession, parseSubagentMeta, parseCodexSession, summarizeCodexTree, type SubagentFile } from '../core';
import type { DiscoverySource, Provider, RunDetail, RunSummary, Settings } from '../shared/types';
import { isDirectory, isGitRoot, listDir, readHeadTail, readText, walkJsonl } from './files';

export interface RunLocation {
  id: string;
  provider: Provider;
  filePath: string;
  /** Claude only: directory holding `subagents/` for this session. */
  sessionDir?: string;
  /** Codex's native parent thread, when this rollout was spawned by another. */
  parentThreadId?: string;
  /** Codex tree root; file watcher events on descendants refresh this run. */
  rootRunId?: string;
  /** On a Codex root, all descendant rollouts, including nested subagents. */
  subagentLocations?: RunLocation[];
}

export interface DiscoveryResult {
  runs: RunSummary[];
  locations: Map<string, RunLocation>;
  sources: DiscoverySource[];
}

export class RunIdentityError extends Error {
  constructor() {
    super('Run identity changed. List runs again to refresh the available IDs.');
    this.name = 'RunIdentityError';
  }
}

function activeWindowMs(settings: Settings): number {
  return settings.activeWindowSeconds * 1000;
}

async function listSubagentFiles(sessionDir: string): Promise<string[]> {
  const dir = join(sessionDir, 'subagents');
  const names = await listDir(dir);
  return names.filter((n) => n.startsWith('agent-') && n.endsWith('.jsonl')).map((n) => join(dir, n));
}

export async function claudeHeader(filePath: string, settings: Settings, now = Date.now()): Promise<{ run: RunSummary; location: RunLocation } | undefined> {
  const sessionId = basename(filePath, '.jsonl');
  if (sessionId.startsWith('agent-')) return undefined;
  const sessionDir = filePath.slice(0, -'.jsonl'.length);
  try {
    const [chunks, subFiles] = await Promise.all([readHeadTail(filePath), listSubagentFiles(sessionDir)]);
    const run = parseClaudeHeader({
      sessionId,
      filePath,
      headText: chunks.head,
      tailText: chunks.tail,
      mtimeMs: chunks.mtimeMs,
      subagentCount: subFiles.length,
      now,
      activeWindowMs: activeWindowMs(settings),
      isGitRoot,
      homeDir: homedir(),
    });
    return { run, location: { id: sessionId, provider: 'claude', filePath, sessionDir } };
  } catch (error) {
    console.warn('[discovery] failed to read', filePath, error);
    return undefined;
  }
}

export async function codexHeader(filePath: string, settings: Settings, now = Date.now()): Promise<{ run: RunSummary; location: RunLocation } | undefined> {
  try {
    const chunks = await readHeadTail(filePath);
    const text = chunks.tail ? `${chunks.head}\n${chunks.tail}` : chunks.head;
    const { run, parentThreadId } = parseCodexSession({ filePath, text, mtimeMs: chunks.mtimeMs, now, activeWindowMs: activeWindowMs(settings), isGitRoot, homeDir: homedir(), headerOnly: true });
    // A new rollout can be observed before its first metadata line is complete.
    // Wait for its native id instead of caching a temporary path-based identity.
    if (run.id === filePath) return undefined;
    return { run, location: { id: run.id, provider: 'codex', filePath, ...(parentThreadId ? { parentThreadId } : {}) } };
  } catch (error) {
    console.warn('[discovery] failed to read', filePath, error);
    return undefined;
  }
}

/** Cheap refresh of the whole Codex tree, including activity in child rollouts. */
export async function codexRunHeader(location: RunLocation, settings: Settings, now = Date.now()): Promise<{ run: RunSummary; location: RunLocation } | undefined> {
  const root = await codexHeader(location.filePath, settings, now);
  if (!root || root.run.id !== location.id) return undefined;
  const children = await mapLimit(location.subagentLocations ?? [], 16, async (child) => {
    const header = await codexHeader(child.filePath, settings, now);
    return header?.run.id === child.id ? header : undefined;
  });
  return { run: summarizeCodexTree(root.run, children.flatMap((child) => child ? [child.run] : [])), location };
}

/** Keep each rollout addressable, while listing only its highest known ancestor. */
function groupCodexHeaders(entries: { run: RunSummary; location: RunLocation }[]): Pick<DiscoveryResult, 'runs' | 'locations'> {
  // Resumed/copied rollouts can repeat a native id. Prefer its freshest file and
  // never count the same thread twice. Path order makes timestamp ties stable.
  const unique = new Map<string, { run: RunSummary; location: RunLocation }>();
  for (const entry of entries) {
    const previous = unique.get(entry.run.id);
    const at = entry.run.lastActivityAt ?? 0;
    const previousAt = previous?.run.lastActivityAt ?? 0;
    if (!previous || at > previousAt || (at === previousAt && entry.location.filePath < previous.location.filePath)) unique.set(entry.run.id, entry);
  }
  const parents = codexParentMap([...unique.values()].map(({ location }) => ({ id: location.id, ...(location.parentThreadId ? { parentThreadId: location.parentThreadId } : {}) })));
  const roots = new Map<string, string>();
  const rootOf = (id: string): string => {
    const path: string[] = [];
    let current = id;
    while (!roots.has(current)) {
      const parent = parents.get(current);
      if (parent === undefined) break;
      path.push(current);
      current = parent;
    }
    const root = roots.get(current) ?? current;
    roots.set(current, root);
    for (const member of path) roots.set(member, root);
    return root;
  };
  const locations = new Map<string, RunLocation>();
  const byRoot = new Map<string, RunSummary[]>();
  for (const entry of unique.values()) {
    const rootRunId = rootOf(entry.location.id);
    locations.set(entry.location.id, { ...entry.location, rootRunId });
    const group = byRoot.get(rootRunId) ?? [];
    group.push(entry.run);
    byRoot.set(rootRunId, group);
  }
  const runs: RunSummary[] = [];
  for (const [rootId, group] of byRoot) {
    const root = group.find((run) => run.id === rootId);
    const location = locations.get(rootId);
    if (!root || !location) continue;
    const descendants = group.filter((run) => run.id !== rootId);
    location.subagentLocations = descendants.flatMap((run) => {
      const child = locations.get(run.id);
      return child ? [child] : [];
    });
    runs.push(summarizeCodexTree(root, descendants));
  }
  return { runs, locations };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function discoverAll(settings: Settings): Promise<DiscoveryResult> {
  const now = Date.now();
  const runs: RunSummary[] = [];
  const locations = new Map<string, RunLocation>();
  const sources: DiscoverySource[] = [];

  // Claude Code: <projects>/<encoded-cwd>/<sessionId>.jsonl
  const claudeDir = settings.claudeSessionsDir;
  if (!existsSync(claudeDir)) {
    sources.push({ provider: 'claude', path: claudeDir, exists: false, sessionCount: 0 });
  } else {
    const projectDirs = (await listDir(claudeDir)).map((n) => join(claudeDir, n));
    const files: string[] = [];
    for (const dir of projectDirs) {
      if (!(await isDirectory(dir))) continue;
      for (const name of await listDir(dir)) if (name.endsWith('.jsonl')) files.push(join(dir, name));
    }
    const results = await mapLimit(files, 16, (f) => claudeHeader(f, settings, now));
    let count = 0;
    for (const result of results) {
      if (!result) continue;
      runs.push(result.run);
      locations.set(result.location.id, result.location);
      count += 1;
    }
    sources.push({ provider: 'claude', path: claudeDir, exists: true, sessionCount: count });
  }

  // Codex: <sessions>/YYYY/MM/DD/rollout-*.jsonl
  const codexDir = settings.codexSessionsDir;
  if (!existsSync(codexDir)) {
    sources.push({ provider: 'codex', path: codexDir, exists: false, sessionCount: 0 });
  } else {
    const files = await walkJsonl(codexDir);
    const results = await mapLimit(files, 16, (f) => codexHeader(f, settings, now));
    const grouped = groupCodexHeaders(results.flatMap((result) => result ? [result] : []));
    runs.push(...grouped.runs);
    for (const [id, location] of grouped.locations) locations.set(id, location);
    sources.push({ provider: 'codex', path: codexDir, exists: true, sessionCount: grouped.runs.length });
  }

  return { runs, locations, sources };
}

/** Parse a run in full, including subagent transcripts. */
export async function loadRunDetail(location: RunLocation, settings: Settings, now = Date.now()): Promise<RunDetail> {
  const window = activeWindowMs(settings);
  if (location.provider === 'codex') {
    const text = await readText(location.filePath);
    const root = parseCodexSession({ filePath: location.filePath, text, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
    if (root.run.id !== location.id) throw new RunIdentityError();
    const descendants = await mapLimit(location.subagentLocations ?? [], 16, async (child) => {
      try {
        const childText = await readText(child.filePath);
        const parsed = parseCodexSession({ filePath: child.filePath, text: childText, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
        // Skip a replaced or partly rewritten file until discovery knows its id.
        return parsed.run.id === child.id ? parsed : undefined;
      } catch (error) {
        // A rollout can disappear between discovery and selection.
        console.warn('[discovery] failed to read subagent', child.filePath, error);
        return undefined;
      }
    });
    return mergeCodexSessions(root, descendants.flatMap((child) => child ? [child] : []));
  }
  const sessionDir = location.sessionDir ?? location.filePath.slice(0, -'.jsonl'.length);
  const [mainText, subPaths] = await Promise.all([readText(location.filePath), listSubagentFiles(sessionDir)]);
  const subagentFiles: SubagentFile[] = await Promise.all(
    subPaths.map(async (path) => {
      const agentId = basename(path, '.jsonl').replace(/^agent-/, '');
      const metaPath = path.replace(/\.jsonl$/, '.meta.json');
      const [text, metaText] = await Promise.all([readText(path), existsSync(metaPath) ? readText(metaPath) : Promise.resolve(undefined)]);
      return { agentId, text, meta: parseSubagentMeta(metaText) };
    }),
  );
  return parseClaudeSession({ sessionId: location.id, filePath: location.filePath, mainText, subagentFiles, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
}
