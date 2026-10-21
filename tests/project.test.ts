import { describe, expect, it } from 'vitest';
import { resolveProject } from '../src/core';

describe('resolveProject', () => {
  it('uses the last path segment by default', () => {
    expect(resolveProject('/home/dev/projects/acme-shop').name).toBe('acme-shop');
    expect(resolveProject('/home/dev/projects/acme-shop/').name).toBe('acme-shop');
    expect(resolveProject('C:\\Users\\dev\\repos\\acme-shop').name).toBe('acme-shop');
  });

  it('walks up to the git root when a probe is available', () => {
    const roots = new Set(['/home/dev/projects/acme-shop']);
    const project = resolveProject('/home/dev/projects/acme-shop/packages/web/src', { isGitRoot: (d) => roots.has(d) });
    expect(project).toEqual({ name: 'acme-shop', path: '/home/dev/projects/acme-shop' });
  });

  it('falls back to parent/segment for generic directory names', () => {
    expect(resolveProject('/home/dev/stockflow/src').name).toBe('stockflow/src');
    expect(resolveProject('/home/dev/tmp').name).toBe('dev/tmp');
  });

  it('labels Claude scheduled job scratch directories', () => {
    expect(resolveProject('/home/dev/.claude/jobs/1f72f412/tmp').name).toBe('Claude scheduled jobs');
  });

  it('prefers a repository URL when one is known', () => {
    expect(resolveProject('/tmp/checkout', { repositoryUrl: 'https://github.com/example/billing-service.git' }).name).toBe('billing-service');
    expect(resolveProject('/tmp/checkout', { repositoryUrl: 'git@github.com:example/infra' }).name).toBe('infra');
  });

  it('handles a missing cwd', () => {
    expect(resolveProject(undefined).name).toBe('Unknown project');
  });
});
