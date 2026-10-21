import { describe, expect, it } from 'vitest';
import { cleanUserText, titleFromPrompt, truncate } from '../src/core';

describe('text helpers', () => {
  it('strips harness wrappers from user text', () => {
    expect(cleanUserText('<system-reminder>x</system-reminder>Hello <command-name>/commit</command-name> world')).toBe('Hello /commit world');
    expect(cleanUserText('<pasted_content id="a">Fix the bug</pasted_content id="a">')).toBe('Fix the bug');
  });

  it('builds titles from the first sentence and truncates at word boundaries', () => {
    expect(titleFromPrompt('Refactor the payments module. Then write tests.')).toBe('Refactor the payments module.');
    expect(titleFromPrompt('ok. Please migrate the database schema to the new format')).toBe('ok. Please migrate the database schema to the new format');
    expect(truncate('a'.repeat(100), 20)).toHaveLength(20);
    expect(truncate('short text', 20)).toBe('short text');
  });
});
