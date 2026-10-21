export function formatRelative(timestamp: number | undefined, now = Date.now()): string {
  if (timestamp === undefined) return '';
  const diff = Math.max(0, now - timestamp);
  const s = Math.round(diff / 1000);
  if (s < 10) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDuration(start: number | undefined, end: number | undefined): string {
  if (start === undefined || end === undefined) return '';
  const total = Math.max(0, Math.round((end - start) / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m < 60) return `${m}m ${s.toString().padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${(m % 60).toString().padStart(2, '0')}m`;
}

export function formatCompact(value: number | undefined): string {
  if (value === undefined) return '–';
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 2 : 1)}M`;
}

export function formatExact(value: number | undefined): string {
  return value === undefined ? '–' : value.toLocaleString();
}

export function formatTime(timestamp: number | undefined): string {
  if (timestamp === undefined) return '';
  return new Date(timestamp).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortModel(model: string | undefined): string {
  if (!model) return '';
  return model
    .replace(/^claude-/, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(\d)-(\d)$/, ' $1.$2')
    .replace(/-/g, ' ');
}
