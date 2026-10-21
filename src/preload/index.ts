import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { IPC } from '../shared/ipc';
import type { AgentStatusChange, RunDetail, RunSummary, Settings, Snapshot } from '../shared/types';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T) => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api = {
  platform: process.platform,
  getSnapshot: (): Promise<Snapshot> => ipcRenderer.invoke(IPC.snapshotGet),
  loadRun: (runId: string): Promise<RunDetail | undefined> => ipcRenderer.invoke(IPC.runLoad, runId),
  loadRunTokens: (runId: string): Promise<RunSummary | undefined> => ipcRenderer.invoke(IPC.runTokens, runId),
  watchRun: (runId: string | undefined): Promise<void> => ipcRenderer.invoke(IPC.runWatch, runId),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
  setSettings: (settings: Settings): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, settings),
  pickDirectory: (current?: string): Promise<string | undefined> => ipcRenderer.invoke(IPC.pickDirectory, current),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.revealPath, path),
  rescan: (): Promise<void> => ipcRenderer.invoke(IPC.rescan),
  onSnapshot: (callback: (snapshot: Snapshot) => void) => subscribe<Snapshot>(IPC.snapshot, callback),
  onRunUpdate: (callback: (detail: RunDetail) => void) => subscribe<RunDetail>(IPC.run, callback),
  onStatusChange: (callback: (changes: AgentStatusChange[]) => void) => subscribe<AgentStatusChange[]>(IPC.statusChange, callback),
};

export type AgentLensApi = typeof api;

contextBridge.exposeInMainWorld('agentlens', api);
