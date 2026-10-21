import { describe, expect, it } from 'vitest';
import { DEFAULT_PRICING, deriveStatus, estimateCost, findPricing, formatCost } from '../src/core';

describe('pricing', () => {
  it('matches models by prefix and estimates cost per million tokens', () => {
    expect(findPricing('claude-opus-5-5-20260101', DEFAULT_PRICING)).toEqual(DEFAULT_PRICING['claude-opus-5-5']);
    const estimate = estimateCost([{ model: 'claude-sonnet-5-5', calls: 1, input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }], DEFAULT_PRICING);
    expect(estimate.total).toBe(3);
    expect(estimate.unpriced).toEqual([]);
  });

  it('reports unpriced models instead of guessing', () => {
    const estimate = estimateCost([{ model: 'mystery-9000', calls: 1, input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }], DEFAULT_PRICING);
    expect(estimate.total).toBe(0);
    expect(estimate.unpriced).toEqual(['mystery-9000']);
    expect(formatCost(0.001)).toBe('<$0.01');
    expect(formatCost(1.234)).toBe('$1.23');
  });
});

describe('deriveStatus', () => {
  const base = { now: 1_000_000, activeWindowMs: 60_000, completed: false, errored: false, pendingToolCall: false };
  it('orders error > finished > running > idle', () => {
    expect(deriveStatus({ ...base, errored: true, completed: true })).toBe('errored');
    expect(deriveStatus({ ...base, completed: true })).toBe('finished');
    expect(deriveStatus({ ...base, lastActivityAt: 990_000 })).toBe('running');
    expect(deriveStatus({ ...base, lastActivityAt: 900_000 })).toBe('idle');
    expect(deriveStatus({ ...base, lastActivityAt: 900_000, pendingToolCall: true })).toBe('idle');
    expect(deriveStatus({ ...base, lastActivityAt: -10_000_000 })).toBe('finished');
    expect(deriveStatus({ ...base, lastActivityAt: -10_000_000, pendingToolCall: true })).toBe('finished');
    expect(deriveStatus(base)).toBe('idle');
  });
});
