import { describe, expect, it } from 'vitest';
import { DEFAULT_ROLES, buildStepPrompt, mergeRoles, permissionArgs, stepArgs, validateRole } from '../src/core';
import type { RoleDefinition } from '../src/shared/types';

const valid: RoleDefinition = {
  id: 'tester',
  name: 'Tester',
  description: 'Runs the tests.',
  systemPrompt: 'You run tests.',
  permission: 'edit',
};

describe('validateRole', () => {
  it('accepts a valid role', () => {
    expect(validateRole(valid)).toBeUndefined();
  });

  it('rejects a bad id', () => {
    expect(validateRole({ ...valid, id: 'Tester' })).toMatch(/id/);
    expect(validateRole({ ...valid, id: 'my role' })).toMatch(/id/);
  });

  it('rejects a missing name or system prompt', () => {
    expect(validateRole({ ...valid, name: '' })).toMatch(/name/);
    expect(validateRole({ ...valid, systemPrompt: '   ' })).toMatch(/systemPrompt/);
  });

  it('rejects a bad permission', () => {
    expect(validateRole({ ...valid, permission: 'admin' })).toMatch(/permission/);
  });

  it('rejects bad extraTools', () => {
    expect(validateRole({ ...valid, extraTools: 'Bash' })).toMatch(/extraTools/);
    expect(validateRole({ ...valid, extraTools: ['Bash', 3] })).toMatch(/extraTools/);
  });

  it('rejects maxTurns out of range', () => {
    expect(validateRole({ ...valid, maxTurns: 0 })).toMatch(/maxTurns/);
    expect(validateRole({ ...valid, maxTurns: 501 })).toMatch(/maxTurns/);
    expect(validateRole({ ...valid, maxTurns: 50 })).toBeUndefined();
  });

  it('rejects non-objects', () => {
    expect(validateRole(undefined)).toBeDefined();
    expect(validateRole('planner')).toBeDefined();
  });
});

describe('mergeRoles', () => {
  it('returns the built-in roles when nothing is customised', () => {
    const { roles, problems } = mergeRoles(undefined);
    expect(roles).toEqual(DEFAULT_ROLES);
    expect(roles).toHaveLength(4);
    expect(problems).toEqual([]);
  });

  it('appends a custom role with a new id', () => {
    const { roles, problems } = mergeRoles([valid]);
    expect(problems).toEqual([]);
    expect(roles).toHaveLength(5);
    const added = roles.find((r) => r.id === 'tester');
    expect(added).toMatchObject({ ...valid, builtIn: false });
  });

  it('overrides a built-in role with the same id', () => {
    const { roles } = mergeRoles([{ ...valid, id: 'coder', name: 'My Coder' }]);
    expect(roles).toHaveLength(4);
    const coder = roles.find((r) => r.id === 'coder');
    expect(coder?.name).toBe('My Coder');
    expect(coder?.builtIn).toBe(false);
  });

  it('drops invalid entries and reports them by index', () => {
    const { roles, problems } = mergeRoles([valid, { id: 'BAD' }, 'nope']);
    expect(roles).toHaveLength(5);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/^roles\[1\]:/);
    expect(problems[1]).toMatch(/^roles\[2\]:/);
  });
});

describe('permissionArgs', () => {
  it('read-only cannot run commands or edit', () => {
    const args = permissionArgs({ permission: 'read-only' });
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'dontAsk']);
    const disallowed = args.slice(args.indexOf('--disallowedTools') + 1);
    expect(disallowed).toEqual(expect.arrayContaining(['Bash', 'Edit', 'Write']));
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed).toContain('Read');
    expect(allowed).not.toContain('Edit');
  });

  it('edit accepts edits and test commands', () => {
    const args = permissionArgs({ permission: 'edit' });
    expect(args.slice(0, 2)).toEqual(['--permission-mode', 'acceptEdits']);
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed).toContain('Edit');
    expect(allowed).toContain('Bash(npm test:*)');
  });

  it('full bypasses permissions and only lists tools when extras are given', () => {
    expect(permissionArgs({ permission: 'full' })).toEqual(['--permission-mode', 'bypassPermissions']);
    expect(permissionArgs({ permission: 'full', extraTools: ['Bash(docker *)'] })).toEqual(['--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash(docker *)']);
  });

  it('includes extraTools in the allowed list', () => {
    const args = permissionArgs({ permission: 'read-only', extraTools: ['Bash(ls:*)'] });
    const allowed = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
    expect(allowed).toContain('Bash(ls:*)');
  });
});

describe('stepArgs', () => {
  const base: RoleDefinition = { ...valid, permission: 'read-only' };

  it('builds the headless invocation', () => {
    const args = stepArgs(base, 'sid-1', 'Do the thing');
    expect(args.slice(0, 2)).toEqual(['-p', 'Do the thing']);
    expect(args).toEqual(expect.arrayContaining(['--output-format', 'stream-json', '--verbose']));
    expect(args[args.indexOf('--session-id') + 1]).toBe('sid-1');
    expect(args[args.indexOf('--append-system-prompt') + 1]).toBe(base.systemPrompt);
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--max-turns');
  });

  it('adds model and max turns when set', () => {
    const args = stepArgs({ ...base, model: 'claude-sonnet-5-5', maxTurns: 12 }, 'sid-2', 'x');
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(args[args.indexOf('--max-turns') + 1]).toBe('12');
  });
});

describe('buildStepPrompt', () => {
  it('describes the first step without a previous section', () => {
    const prompt = buildStepPrompt('  Add dark mode  ', undefined, { index: 0, total: 3 });
    expect(prompt).toContain('Goal: Add dark mode');
    expect(prompt).toContain('step 1 of 3');
    expect(prompt).not.toContain('previous step');
    expect(prompt).not.toContain('---');
  });

  it('hands the previous output to later steps', () => {
    const prompt = buildStepPrompt('Add dark mode', { roleName: 'Planner', output: '  1. Edit theme.ts\n' }, { index: 1, total: 3 });
    expect(prompt).toContain('step 2 of 3');
    expect(prompt).toContain('previous step (Planner)');
    expect(prompt).toContain('---\n1. Edit theme.ts\n---');
  });
});
