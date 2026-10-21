import { basename } from './text';

export interface ProjectInfo {
  name: string;
  path: string;
}

export interface ProjectResolveOptions {
  /** Returns true when the given directory contains a `.git` entry. Injected so tests stay pure. */
  isGitRoot?: (dir: string) => boolean;
  /** Repository URL when the log already names one (Codex `session_meta.git.repository_url`). */
  repositoryUrl?: string;
  /** Upper bound on parent directories to walk when probing for a git root. */
  maxDepth?: number;
  /** The user's home directory; sessions started there are labeled "Home". */
  homeDir?: string;
}

const GENERIC_SEGMENTS = new Set(['tmp', 'temp', 'src', 'app', 'www', 'repo', 'project', 'workspace', 'code', '.']);

function parentOf(dir: string): string | undefined {
  const trimmed = dir.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) return undefined;
  return trimmed.slice(0, idx);
}

function repoNameFromUrl(url: string): string | undefined {
  const match = url.trim().replace(/\.git\/?$/, '').match(/([^/:]+)$/);
  return match?.[1];
}

/**
 * Derive a project name from the session's working directory.
 * Preference: git repository root name → meaningful last path segment → parent segment.
 */
export function resolveProject(cwd: string | undefined, options: ProjectResolveOptions = {}): ProjectInfo {
  if (!cwd) return { name: 'Unknown project', path: '' };
  const normalized = cwd.replace(/[\\/]+$/, '') || cwd;

  if (/[\\/]\.claude[\\/]jobs[\\/]/.test(normalized)) {
    return { name: 'Claude scheduled jobs', path: normalized };
  }
  if (options.homeDir && normalized === options.homeDir.replace(/[\\/]+$/, '')) {
    return { name: 'Home', path: normalized };
  }

  if (options.repositoryUrl) {
    const fromUrl = repoNameFromUrl(options.repositoryUrl);
    if (fromUrl) return { name: fromUrl, path: normalized };
  }

  if (options.isGitRoot) {
    let dir: string | undefined = normalized;
    let depth = 0;
    const maxDepth = options.maxDepth ?? 8;
    while (dir && depth <= maxDepth) {
      if (options.isGitRoot(dir)) return { name: basename(dir), path: dir };
      dir = parentOf(dir);
      depth += 1;
    }
  }

  const last = basename(normalized);
  if (!GENERIC_SEGMENTS.has(last.toLowerCase())) return { name: last, path: normalized };
  const parent = parentOf(normalized);
  const parentName = parent ? basename(parent) : '';
  if (parentName && !GENERIC_SEGMENTS.has(parentName.toLowerCase())) {
    return { name: `${parentName}/${last}`, path: normalized };
  }
  return { name: last || normalized, path: normalized };
}
