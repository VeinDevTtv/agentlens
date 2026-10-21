import type { ModelPricing, ModelUsage, TokenUsage } from '../shared/types';

/**
 * Default per-model pricing in USD per million tokens. Editable in Settings.
 * Keys are matched by prefix, so `claude-opus-5-5` matches `claude-opus-5-5-20260101`.
 */
export const DEFAULT_PRICING: Record<string, ModelPricing> = {
  'claude-fable-5-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-opus-5-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'o3': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 0 },
};

export function findPricing(model: string | undefined, table: Record<string, ModelPricing>): ModelPricing | undefined {
  if (!model) return undefined;
  const lower = model.toLowerCase();
  if (table[lower]) return table[lower];
  let best: { key: string; pricing: ModelPricing } | undefined;
  for (const [key, pricing] of Object.entries(table)) {
    const k = key.toLowerCase();
    if (lower.startsWith(k) || lower.includes(k)) {
      if (!best || k.length > best.key.length) best = { key: k, pricing };
    }
  }
  return best?.pricing;
}

export function costForUsage(usage: TokenUsage, pricing: ModelPricing): number {
  const perToken = 1 / 1_000_000;
  return (
    usage.input * pricing.input * perToken +
    usage.output * pricing.output * perToken +
    usage.cacheRead * pricing.cacheRead * perToken +
    usage.cacheWrite * pricing.cacheWrite * perToken
  );
}

export interface CostEstimate {
  total: number;
  /** Models that had no pricing entry; their tokens are excluded from `total`. */
  unpriced: string[];
  byModel: Array<{ model: string; cost: number | undefined }>;
}

export function estimateCost(usageByModel: ModelUsage[], table: Record<string, ModelPricing>): CostEstimate {
  let total = 0;
  const unpriced: string[] = [];
  const byModel: CostEstimate['byModel'] = [];
  for (const usage of usageByModel) {
    const pricing = findPricing(usage.model, table);
    if (!pricing) {
      unpriced.push(usage.model);
      byModel.push({ model: usage.model, cost: undefined });
      continue;
    }
    const cost = costForUsage(usage, pricing);
    total += cost;
    byModel.push({ model: usage.model, cost });
  }
  return { total, unpriced, byModel };
}

export function formatCost(value: number): string {
  if (value === 0) return '$0.00';
  if (value < 0.01) return '<$0.01';
  return `$${value.toFixed(2)}`;
}
