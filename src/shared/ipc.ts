/** IPC channel names shared by main and preload. */
export const IPC = {
  snapshotGet: 'snapshot:get',
  runLoad: 'run:load',
  runTokens: 'run:tokens',
  runWatch: 'run:watch',
  settingsGet: 'settings:get',
  settingsSet: 'settings:set',
  pickDirectory: 'dialog:pick-directory',
  revealPath: 'shell:reveal',
  rescan: 'app:rescan',
  // main → renderer
  snapshot: 'event:snapshot',
  run: 'event:run',
  statusChange: 'event:status-change',
} as const;
