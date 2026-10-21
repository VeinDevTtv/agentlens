import { existsSync, promises as fs, type Dirent } from 'node:fs';
import { join } from 'node:path';

export const HEAD_BYTES = 256 * 1024;
export const TAIL_BYTES = 96 * 1024;

export function isGitRoot(dir: string): boolean {
  try {
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

export interface HeadTail {
  head: string;
  tail: string;
  size: number;
  mtimeMs: number;
}

/** Read the first and last chunks of a file without loading the middle. */
export async function readHeadTail(filePath: string, headBytes = HEAD_BYTES, tailBytes = TAIL_BYTES): Promise<HeadTail> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const size = stat.size;
    if (size <= headBytes + tailBytes) {
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      const text = buffer.toString('utf8');
      return { head: text, tail: '', size, mtimeMs: stat.mtimeMs };
    }
    const headBuffer = Buffer.alloc(headBytes);
    const tailBuffer = Buffer.alloc(tailBytes);
    await Promise.all([handle.read(headBuffer, 0, headBytes, 0), handle.read(tailBuffer, 0, tailBytes, size - tailBytes)]);
    // Drop the partial first line of the tail chunk.
    let tail = tailBuffer.toString('utf8');
    const firstNewline = tail.indexOf('\n');
    if (firstNewline >= 0) tail = tail.slice(firstNewline + 1);
    return { head: headBuffer.toString('utf8'), tail, size, mtimeMs: stat.mtimeMs };
  } finally {
    await handle.close();
  }
}

export async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

export async function listDir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch {
    return [];
  }
}

export async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function walkJsonl(dir: string, maxDepth = 6): Promise<string[]> {
  const out: string[] = [];
  const visit = async (current: string, depth: number) => {
    if (depth > maxDepth) return;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) await visit(full, depth + 1);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  };
  await visit(dir, 0);
  return out;
}
