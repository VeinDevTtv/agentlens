import type { AgentLensApi } from './index';

declare global {
  interface Window {
    agentlens?: AgentLensApi;
  }
}

export {};
