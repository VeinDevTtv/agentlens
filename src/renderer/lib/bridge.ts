import type { AgentLensApi } from '../../preload/index';

/** Typed access to the preload bridge. Undefined when running in a plain browser (vite dev:web). */
export function bridge(): AgentLensApi | undefined {
  return window.agentlens;
}

export function hasBridge(): boolean {
  return !!window.agentlens;
}
