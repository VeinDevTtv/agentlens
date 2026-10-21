import { describe, expect, it } from 'vitest';
import { describeToolCall } from '../src/core';

const cwd = '/home/dev/app';

describe('describeToolCall', () => {
  it('describes file edits relative to the working directory', () => {
    expect(describeToolCall('Edit', { file_path: '/home/dev/app/src/App.tsx' }, cwd).summary).toBe('Editing src/App.tsx');
    expect(describeToolCall('Write', { file_path: '/home/dev/app/README.md' }, cwd)).toMatchObject({ kind: 'edit', file: 'README.md', writes: ['README.md'] });
    expect(describeToolCall('Read', { file_path: '/other/place.ts' }, cwd).summary).toBe('Reading /other/place.ts');
  });

  it('prefers the Bash description, otherwise shortens the command', () => {
    expect(describeToolCall('Bash', { command: 'npm test', description: 'Run unit tests' }).summary).toBe('Run unit tests');
    expect(describeToolCall('Bash', { command: 'cd /x && npm test -- --watch' }).summary).toBe('Running npm test -- --watch');
  });

  it('describes searches, delegation, and web calls', () => {
    expect(describeToolCall('Grep', { pattern: 'auth' }).summary).toBe("Searching for 'auth'");
    expect(describeToolCall('Glob', { pattern: '**/*.ts' }).summary).toBe('Finding files matching **/*.ts');
    expect(describeToolCall('Agent', { description: 'Review the diff' }).summary).toBe('Delegating: Review the diff');
    expect(describeToolCall('WebFetch', { url: 'https://docs.example.com/a/b' }).summary).toBe('Fetching docs.example.com');
    expect(describeToolCall('WebSearch', { query: 'vitest config' }).summary).toBe("Searching the web for 'vitest config'");
    expect(describeToolCall('TodoWrite', {}).kind).toBe('plan');
    expect(describeToolCall('SubagentHandback', { message: 'done' }).summary).toBe('Reporting back to parent');
  });

  it('handles Codex tools', () => {
    expect(describeToolCall('exec_command', { cmd: 'pytest -q' }).summary).toBe('Running pytest -q');
    const patch = describeToolCall('apply_patch', { input: '*** Begin Patch\n*** Add File: /home/dev/app/a.ts\n*** Update File: /home/dev/app/b.ts\n*** End Patch' }, cwd);
    expect(patch.summary).toBe('Editing a.ts and 1 more');
    expect(patch.writes).toEqual(['a.ts', 'b.ts']);
  });

  it('prettifies unknown and MCP tool names', () => {
    expect(describeToolCall('mcp__github__list_issues', {}).summary).toBe('Using github / list issues');
    expect(describeToolCall('SomethingNew', {}).summary).toBe('Using SomethingNew');
  });
});
