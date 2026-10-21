import type { ReactNode } from 'react';

/** Inline spans: `code` and **bold**. Everything else is plain text (React escapes it). */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let index = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    if (start > last) parts.push(text.slice(last, start));
    const token = match[0];
    const key = `${keyPrefix}-${index++}`;
    parts.push(token.startsWith('`') ? <code key={key}>{token.slice(1, -1)}</code> : <b key={key}>{token.slice(2, -2)}</b>);
    last = start + token.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

const LIST_ITEM = /^\s*[-*]\s+/;

/** Small markdown subset for chat bubbles: paragraphs, ``` fences, - lists, ## headings, `code`, **bold**. */
export function Markdown({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split('\n');
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      const k = `p${blocks.length}`;
      blocks.push(<p key={k}>{inline(paragraph.join('\n'), k)}</p>);
    }
    paragraph = [];
  };
  const flushList = () => {
    if (list.length) {
      const k = `l${blocks.length}`;
      blocks.push(
        <ul key={k}>
          {list.map((item, i) => (
            <li key={i}>{inline(item, `${k}-${i}`)}</li>
          ))}
        </ul>,
      );
    }
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimStart().startsWith('```')) {
      flushParagraph();
      flushList();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) code.push(lines[i++] ?? '');
      blocks.push(<pre key={`c${blocks.length}`}>{code.join('\n')}</pre>);
    } else if (/^#{1,6}\s+/.test(line)) {
      flushParagraph();
      flushList();
      const k = `h${blocks.length}`;
      blocks.push(<h4 key={k}>{inline(line.replace(/^#{1,6}\s+/, ''), k)}</h4>);
    } else if (LIST_ITEM.test(line)) {
      flushParagraph();
      list.push(line.replace(LIST_ITEM, ''));
    } else if (!line.trim()) {
      flushParagraph();
      flushList();
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="md">{blocks}</div>;
}
