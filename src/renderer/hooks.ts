import { useEffect } from 'react';
import { bridge } from './lib/bridge';
import { useStore } from './store';

/** Wire the preload bridge into the store: initial snapshot, live updates, settings. */
export function useMonitor(): void {
  const setSnapshot = useStore((s) => s.setSnapshot);
  const setSnapshotError = useStore((s) => s.setSnapshotError);
  const setDetail = useStore((s) => s.setDetail);
  const setSettings = useStore((s) => s.setSettings);

  useEffect(() => {
    const api = bridge();
    if (!api) {
      setSnapshotError('The desktop bridge is unavailable. Run the app with `npm run dev`, not in a plain browser tab.');
      return;
    }
    let cancelled = false;
    void api.getSettings().then((settings) => !cancelled && setSettings(settings));
    void api
      .getSnapshot()
      .then((snapshot) => !cancelled && setSnapshot(snapshot))
      .catch((error: unknown) => !cancelled && setSnapshotError(error instanceof Error ? error.message : String(error)));
    const offSnapshot = api.onSnapshot((snapshot) => setSnapshot(snapshot));
    const offRun = api.onRunUpdate((detail) => setDetail(detail));
    return () => {
      cancelled = true;
      offSnapshot();
      offRun();
    };
  }, [setSnapshot, setSnapshotError, setDetail, setSettings]);
}

/** Load the selected run's detail and tell the main process to keep it fresh. */
export function useSelectedRun(): void {
  const selectedRunId = useStore((s) => s.selectedRunId);
  const setDetail = useStore((s) => s.setDetail);
  const setDetailLoading = useStore((s) => s.setDetailLoading);
  const mergeRun = useStore((s) => s.mergeRun);

  useEffect(() => {
    const api = bridge();
    if (!api) return;
    void api.watchRun(selectedRunId);
    if (!selectedRunId) return;
    let cancelled = false;
    setDetailLoading(true);
    void api
      .loadRun(selectedRunId)
      .then((detail) => {
        if (cancelled) return;
        if (detail) {
          setDetail(detail);
          mergeRun(detail.run);
        } else setDetailLoading(false);
      })
      .catch(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedRunId, setDetail, setDetailLoading, mergeRun]);
}

/** Keep relative times and elapsed counters moving. */
export function useClock(intervalMs = 1000): void {
  const tickNow = useStore((s) => s.tickNow);
  useEffect(() => {
    const timer = setInterval(tickNow, intervalMs);
    return () => clearInterval(timer);
  }, [tickNow, intervalMs]);
}

/** Apply the theme preference to <html data-theme>. */
export function useTheme(): void {
  const theme = useStore((s) => s.settings.theme);
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const resolved = theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
      document.documentElement.dataset.theme = resolved;
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}
