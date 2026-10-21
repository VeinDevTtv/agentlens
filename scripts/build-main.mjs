import { build } from 'esbuild';

const watch = process.argv.includes('--watch');
const common = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  sourcemap: true,
  external: ['electron'],
  logLevel: 'info',
};

const entries = [
  { entryPoints: ['src/main/index.ts'], outfile: 'dist-electron/main.cjs' },
  { entryPoints: ['src/preload/index.ts'], outfile: 'dist-electron/preload.cjs' },
];

if (watch) {
  const { context } = await import('esbuild');
  for (const entry of entries) {
    const ctx = await context({ ...common, ...entry });
    await ctx.watch();
  }
  console.log('[build-main] watching');
} else {
  await Promise.all(entries.map((entry) => build({ ...common, ...entry })));
}
