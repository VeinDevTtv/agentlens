/** Small text helpers shared by the parsers and the renderer. */

const ELLIPSIS = '…';

export function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + ELLIPSIS;
}

/**
 * Strip harness-injected wrappers from a user message so only the human's words remain:
 * system reminders, pasted-content tags, slash-command envelopes, task notifications.
 */
export function cleanUserText(raw: string): string {
  let text = raw;
  text = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  text = text.replace(/<task-notification>[\s\S]*?<\/task-notification>/g, ' ');
  text = text.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ');
  text = text.replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ');
  text = text.replace(/<command-args>([\s\S]*?)<\/command-args>/g, ' $1 ');
  text = text.replace(/<command-name>([\s\S]*?)<\/command-name>/g, ' $1 ');
  text = text.replace(/<pasted_content[^>]*>|<\/pasted_content[^>]*>/g, ' ');
  text = text.replace(/<\/?[a-z_-]+(?:\s[^>]*)?>/gi, (tag) => (/^<\/?(b|i|code|pre)>$/i.test(tag) ? tag : ' '));
  return text.replace(/\s+/g, ' ').trim();
}

/** True for harness notices such as "[Request interrupted by user]" that should never become a title. */
export function isSystemNotice(text: string): boolean {
  const t = text.trim();
  return /^\[[^\]]*\]$/.test(t) || /^\[Request interrupted/i.test(t);
}

/** Turn a user prompt into a short run or task title. */
export function titleFromPrompt(raw: string, max = 60): string {
  const text = cleanUserText(raw);
  if (!text) return '';
  const firstLine = text.split(/(?<=[.!?])\s+/)[0] ?? text;
  return truncate(firstLine.length >= 12 ? firstLine : text, max);
}

export function relativePath(filePath: string, cwd: string | undefined): string {
  if (!cwd) return filePath;
  const normalizedCwd = cwd.replace(/[\\/]+$/, '');
  if (filePath === normalizedCwd) return '.';
  if (filePath.startsWith(normalizedCwd + '/') || filePath.startsWith(normalizedCwd + '\\')) {
    return filePath.slice(normalizedCwd.length + 1);
  }
  return filePath;
}

export function basename(filePath: string): string {
  const parts = filePath.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

export function firstTextBlock(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  for (const block of content) {
    if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
      const text = (block as { text?: unknown }).text;
      if (typeof text === 'string' && text.trim()) return text;
    }
  }
  return '';
}

export function allText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as { type?: unknown; text?: unknown };
      return b.type === 'text' && typeof b.text === 'string' ? b.text : '';
    })
    .filter(Boolean)
    .join('\n');
}
