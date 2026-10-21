import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../shared/ipc';
import type { WorkflowStartRequest } from '../shared/types';
import type { Monitor } from './monitor';
import type { Orchestrator } from './orchestrator';
import type { SettingsStore } from './settings';

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function toStartRequest(raw: unknown): WorkflowStartRequest {
  if (!isObject(raw)) throw new Error('Invalid workflow request');
  const roleIds = Array.isArray(raw.roleIds) ? raw.roleIds.filter((v): v is string => typeof v === 'string') : [];
  return {
    goal: typeof raw.goal === 'string' ? raw.goal : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    ...(typeof raw.templateId === 'string' ? { templateId: raw.templateId } : {}),
    ...(roleIds.length ? { roleIds } : {}),
    ...(typeof raw.name === 'string' ? { name: raw.name } : {}),
  };
}

export function registerIpc(monitor: Monitor, settings: SettingsStore, orchestrator: Orchestrator): void {
  ipcMain.handle(IPC.snapshotGet, () => monitor.snapshot());
  ipcMain.handle(IPC.runLoad, (_event, runId: unknown) => (typeof runId === 'string' ? monitor.loadRun(runId) : undefined));
  ipcMain.handle(IPC.runTokens, (_event, runId: unknown) => (typeof runId === 'string' ? monitor.loadRunTokens(runId) : undefined));
  ipcMain.handle(IPC.runWatch, (_event, runId: unknown) => monitor.watchRun(typeof runId === 'string' ? runId : undefined));
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, async (_event, next: unknown) => {
    const saved = settings.set(next);
    await monitor.updateSettings(saved);
    orchestrator.updateSettings(saved);
    return saved;
  });
  ipcMain.handle(IPC.pickDirectory, async (event, current: unknown) => {
    const window = BrowserWindow.fromWebContents(event.sender);
    const options = { properties: ['openDirectory' as const], ...(typeof current === 'string' ? { defaultPath: current } : {}) };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    return result.canceled ? undefined : result.filePaths[0];
  });
  ipcMain.handle(IPC.revealPath, (_event, path: unknown) => {
    if (typeof path === 'string' && path) shell.showItemInFolder(path);
  });
  ipcMain.handle(IPC.rescan, () => monitor.rescan());

  ipcMain.handle(IPC.workflowList, () => orchestrator.list());
  ipcMain.handle(IPC.workflowStart, (_event, raw: unknown) => orchestrator.start(toStartRequest(raw)));
  ipcMain.handle(IPC.workflowCancel, (_event, id: unknown) => (typeof id === 'string' ? orchestrator.cancel(id) : undefined));
  ipcMain.handle(IPC.workflowDelete, (_event, id: unknown) => {
    if (typeof id === 'string') orchestrator.delete(id);
  });
  ipcMain.handle(IPC.orchestratorConfig, () => orchestrator.config());

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  monitor.on('snapshot', (snapshot) => broadcast(IPC.snapshot, snapshot));
  monitor.on('run', (detail) => broadcast(IPC.run, detail));
  monitor.on('status-change', (changes) => broadcast(IPC.statusChange, changes));
  orchestrator.on('workflow', (workflow) => broadcast(IPC.workflow, workflow));
}
