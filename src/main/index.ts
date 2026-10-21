import { app, BrowserWindow, nativeTheme, shell } from 'electron';
import { join } from 'node:path';
import { registerIpc } from './ipc';
import { Monitor } from './monitor';
import { Orchestrator } from './orchestrator';
import { SettingsStore } from './settings';

const isDev = !!process.env.VITE_DEV_SERVER_URL;

function createWindow(settings: SettingsStore): BrowserWindow {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: 'AgentLens',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const theme = settings.get().theme;
  nativeTheme.themeSource = theme;

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void window.loadURL(process.env.VITE_DEV_SERVER_URL as string);
  } else {
    void window.loadFile(join(__dirname, '../dist/index.html'));
  }
  return window;
}

app.setName('AgentLens');

void app.whenReady().then(async () => {
  const settings = new SettingsStore();
  const monitor = new Monitor(settings.get());
  const orchestrator = new Orchestrator(app.getPath('userData'), settings.get());
  registerIpc(monitor, settings, orchestrator);
  createWindow(settings);
  await monitor.start();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(settings);
  });
  app.on('before-quit', () => {
    orchestrator.stop();
    monitor.stop();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
