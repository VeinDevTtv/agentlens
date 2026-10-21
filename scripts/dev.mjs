// Dev orchestrator: start Vite, build main+preload, launch Electron pointed at the dev server.
import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import electronPath from 'electron';

const DEV_URL = 'http://127.0.0.1:5174';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const vite = spawn(npx, ['vite', '--host', '127.0.0.1', '--port', '5174', '--strictPort'], { stdio: 'inherit', shell: process.platform === 'win32' });

async function waitForServer(url, attempts = 100) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Vite dev server did not start at ${url}`);
}

const common = { bundle: true, platform: 'node', target: 'node22', format: 'cjs', sourcemap: true, external: ['electron'] };
await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist-electron/main.cjs' }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist-electron/preload.cjs' }),
]);
await waitForServer(DEV_URL);

const electron = spawn(electronPath, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: DEV_URL },
});

const shutdown = () => {
  vite.kill();
  electron.kill();
  process.exit(0);
};
electron.on('exit', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
