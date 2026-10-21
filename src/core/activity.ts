import type { ToolKind } from '../shared/types';
import { relativePath, truncate } from './text';

export interface ActivityDescription {
  kind: ToolKind;
  summary: string;
  file?: string;
  /** Files created or modified by this call (used for "Files touched"). */
  writes: string[];
}

type Input = Record<string, unknown>;

function str(input: Input, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function shortCommand(command: string): string {
  const firstLine = command.split('\n').find((line) => line.trim()) ?? command;
  return truncate(firstLine.replace(/^\s*(cd\s+\S+\s*&&\s*)/, ''), 48);
}

function patchFiles(patch: string): string[] {
  const files: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
    if (match[1]) files.push(match[1].trim());
  }
  return files;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return truncate(url, 40);
  }
}

/** Translate a raw tool call into a human sentence such as "Editing src/App.tsx". */
export function describeToolCall(name: string, rawInput: unknown, cwd?: string): ActivityDescription {
  const input: Input = rawInput && typeof rawInput === 'object' ? (rawInput as Input) : {};
  const rel = (p: string) => relativePath(p, cwd);
  const filePath = str(input, 'file_path') ?? str(input, 'path') ?? str(input, 'notebook_path');

  switch (name) {
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return filePath
        ? { kind: 'edit', summary: `Editing ${rel(filePath)}`, file: rel(filePath), writes: [rel(filePath)] }
        : { kind: 'edit', summary: 'Editing a file', writes: [] };
    case 'Write':
      return filePath
        ? { kind: 'edit', summary: `Writing ${rel(filePath)}`, file: rel(filePath), writes: [rel(filePath)] }
        : { kind: 'edit', summary: 'Writing a file', writes: [] };
    case 'Read':
      return filePath
        ? { kind: 'read', summary: `Reading ${rel(filePath)}`, file: rel(filePath), writes: [] }
        : { kind: 'read', summary: 'Reading a file', writes: [] };
    case 'Bash':
    case 'exec_command':
    case 'shell':
    case 'shell_command': {
      const description = str(input, 'description');
      const command = str(input, 'command') ?? str(input, 'cmd');
      if (description) return { kind: 'shell', summary: truncate(description, 60), writes: [] };
      if (command) return { kind: 'shell', summary: `Running ${shortCommand(command)}`, writes: [] };
      return { kind: 'shell', summary: 'Running a command', writes: [] };
    }
    case 'write_stdin':
      return { kind: 'shell', summary: 'Sending input to a running command', writes: [] };
    case 'Grep': {
      const pattern = str(input, 'pattern');
      return { kind: 'search', summary: pattern ? `Searching for '${truncate(pattern, 32)}'` : 'Searching code', writes: [] };
    }
    case 'Glob': {
      const pattern = str(input, 'pattern');
      return { kind: 'search', summary: pattern ? `Finding files matching ${truncate(pattern, 32)}` : 'Finding files', writes: [] };
    }
    case 'Agent':
    case 'Task': {
      const description = str(input, 'description');
      return { kind: 'delegate', summary: description ? `Delegating: ${truncate(description, 48)}` : 'Delegating to a subagent', writes: [] };
    }
    case 'SendMessage':
      return { kind: 'delegate', summary: 'Messaging a subagent', writes: [] };
    case 'WebFetch': {
      const url = str(input, 'url');
      return { kind: 'web', summary: url ? `Fetching ${hostOf(url)}` : 'Fetching a web page', writes: [] };
    }
    case 'WebSearch': {
      const query = str(input, 'query');
      return { kind: 'web', summary: query ? `Searching the web for '${truncate(query, 32)}'` : 'Searching the web', writes: [] };
    }
    case 'TodoWrite':
    case 'TaskCreate':
    case 'TaskUpdate':
    case 'update_plan':
      return { kind: 'plan', summary: 'Updating the task list', writes: [] };
    case 'apply_patch': {
      const patch = str(input, 'input') ?? str(input, 'patch') ?? '';
      const files = patchFiles(patch).map(rel);
      const first = files[0];
      const summary = first
        ? files.length > 1
          ? `Editing ${first} and ${files.length - 1} more`
          : `Editing ${first}`
        : 'Applying a patch';
      return first ? { kind: 'edit', summary, file: first, writes: files } : { kind: 'edit', summary, writes: files };
    }
    case 'SubagentHandback':
      return { kind: 'other', summary: 'Reporting back to parent', writes: [] };
    case 'AskUserQuestion':
      return { kind: 'other', summary: 'Waiting for an answer from you', writes: [] };
    case 'Skill':
      return { kind: 'other', summary: `Loading skill ${str(input, 'skill') ?? ''}`.trim(), writes: [] };
    default: {
      const pretty = name.replace(/^mcp__/, '').replace(/__/g, ' / ').replace(/[_-]+/g, ' ');
      return { kind: 'other', summary: `Using ${truncate(pretty, 40)}`, writes: [] };
    }
  }
}
