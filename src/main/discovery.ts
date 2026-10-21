import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { parseClaudeHeader, parseClaudeSession, parseSubagentMeta, parseCodexSession, type SubagentFile } from '../core';
import type { DiscoverySource, Provider, RunDetail, RunSummary, Settings } from '../shared/types';
import { isDirectory, isGitRoot, listDir, readHeadTail, readText, walkJsonl } from './files';

export interface RunLocation {
  id: string;
  provider: Provider;
  filePath: string;
  /** Claude only: directory holding `subagents/` for this session. */
  sessionDir?: string;
}

export interface DiscoveryResult {
  runs: RunSummary[];
  locations: Map<string, RunLocation>;
  sources: DiscoverySource[];
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
    const { run } = parseCodexSession({ filePath, text, mtimeMs: chunks.mtimeMs, now, activeWindowMs: activeWindowMs(settings), isGitRoot, homeDir: homedir(), headerOnly: true });
    return { run, location: { id: run.id, provider: 'codex', filePath } };
  } catch (error) {
    console.warn('[discovery] failed to read', filePath, error);
    return undefined;
  }
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
    let count = 0;
    for (const result of results) {
      if (!result) continue;
      runs.push(result.run);
      locations.set(result.location.id, result.location);
      count += 1;
    }
    sources.push({ provider: 'codex', path: codexDir, exists: true, sessionCount: count });
  }

  return { runs, locations, sources };
}

/** Parse a run in full, including subagent transcripts. */
export async function loadRunDetail(location: RunLocation, settings: Settings, now = Date.now()): Promise<RunDetail> {
  const window = activeWindowMs(settings);
  if (location.provider === 'codex') {
    const text = await readText(location.filePath);
    const { run, agents } = parseCodexSession({ filePath: location.filePath, text, now, activeWindowMs: window, isGitRoot, homeDir: homedir() });
    return { run, agents };
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
