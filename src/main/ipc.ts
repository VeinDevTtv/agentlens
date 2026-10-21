import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { IPC } from '../shared/ipc';
import type { Monitor } from './monitor';
import type { SettingsStore } from './settings';

export function registerIpc(monitor: Monitor, settings: SettingsStore): void {
  ipcMain.handle(IPC.snapshotGet, () => monitor.snapshot());
  ipcMain.handle(IPC.runLoad, (_event, runId: unknown) => (typeof runId === 'string' ? monitor.loadRun(runId) : undefined));
  ipcMain.handle(IPC.runTokens, (_event, runId: unknown) => (typeof runId === 'string' ? monitor.loadRunTokens(runId) : undefined));
  ipcMain.handle(IPC.runWatch, (_event, runId: unknown) => monitor.watchRun(typeof runId === 'string' ? runId : undefined));
  ipcMain.handle(IPC.settingsGet, () => settings.get());
  ipcMain.handle(IPC.settingsSet, async (_event, next: unknown) => {
    const saved = settings.set(next);
    await monitor.updateSettings(saved);
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

  const broadcast = (channel: string, payload: unknown) => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send(channel, payload);
    }
  };
  monitor.on('snapshot', (snapshot) => broadcast(IPC.snapshot, snapshot));
  monitor.on('run', (detail) => broadcast(IPC.run, detail));
  monitor.on('status-change', (changes) => broadcast(IPC.statusChange, changes));
}
