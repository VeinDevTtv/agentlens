import type { ModelUsage, TokenUsage } from '../shared/types';

export const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export class UsageAccumulator {
  private readonly byModel = new Map<string, ModelUsage>();

  add(model: string | undefined, usage: TokenUsage): void {
    const key = model ?? 'unknown';
    const existing = this.byModel.get(key) ?? { model: key, calls: 0, ...EMPTY_USAGE };
    const merged = { ...existing, ...addUsage(existing, usage), calls: existing.calls + 1 };
    this.byModel.set(key, merged);
  }

  total(): TokenUsage {
    let sum = EMPTY_USAGE;
    for (const usage of this.byModel.values()) sum = addUsage(sum, usage);
    return sum;
  }

  models(): ModelUsage[] {
    return [...this.byModel.values()].sort((a, b) => totalTokens(b) - totalTokens(a));
  }

  /** Model with the most calls, used as the agent's display model. */
  primaryModel(): string | undefined {
    let best: ModelUsage | undefined;
    for (const usage of this.byModel.values()) {
      if (usage.model === 'unknown') continue;
      if (!best || usage.calls > best.calls) best = usage;
    }
    return best?.model;
  }
}
