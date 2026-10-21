import { AlertTriangle, ChevronDown, ChevronRight, FolderOpen, Loader2, MessageSquare, Send, Square, Trash2, Workflow, Wrench } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { formatCost } from '../../core/pricing';
import type { Chat, ChatMessage, ChatStatus } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { formatRelative, formatTime } from '../lib/format';
import { Markdown } from '../lib/markdown';
import { useStore } from '../store';

const EXAMPLES = ['Summarize how this project is structured', 'Find and fix the failing tests', 'Plan, build and review a small feature I describe next'];
const MAX_LINES = 8;
const LINE_HEIGHT = 19;

function StatusLine({ status }: { status: ChatStatus }) {
  if (status === 'thinking') {
    return (
      <span className="badge running chat-status">
        <Loader2 size={12} className="spin" aria-hidden="true" /> Conductor is thinking…
      </span>
    );
  }
  if (status === 'waiting-workflow') {
    return (
      <span className="badge idle chat-status">
        <Workflow size={12} aria-hidden="true" /> Waiting for workflow…
      </span>
    );
  }
  return <span className="badge finished chat-status">Idle</span>;
}

function ToolCalls({ message }: { message: ChatMessage }) {
  const [open, setOpen] = useState(false);
  const calls = message.toolCalls ?? [];
  if (!calls.length) return null;
  const latest = calls[calls.length - 1];
  return (
    <div className="msg-tools">
      {message.pending && latest && !open && (
        <div className="msg-tool current" title={`${latest.name} · ${latest.summary}`}>
          <Wrench size={11} aria-hidden="true" /> <b>{latest.name}</b> {latest.summary}
        </div>
      )}
      <button type="button" className="msg-tools-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}
        {calls.length} tool {calls.length === 1 ? 'call' : 'calls'}
      </button>
      {open && (
        <ol className="msg-tool-list">
          {calls.map((call, i) => (
            <li key={i} className="msg-tool" title={`${call.name} · ${call.summary}`}>
              <b>{call.name}</b> {call.summary && <span>· {call.summary}</span>}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function MessageRow({ message, onOpenWorkflow }: { message: ChatMessage; onOpenWorkflow: (id: string) => void }) {
  const time = formatTime(message.at);
  if (message.kind === 'event') {
    return (
      <div className="msg event" title={time}>
        {message.workflowId ? (
          <button type="button" className="msg-event-link" onClick={() => message.workflowId && onOpenWorkflow(message.workflowId)} title="Open workflow">
            <Workflow size={12} aria-hidden="true" /> {message.text}
          </button>
        ) : (
          <span>{message.text}</span>
        )}
      </div>
    );
  }
  if (message.kind === 'user') {
    return (
      <div className="msg user" title={time}>
        <div className="bubble">{message.text}</div>
      </div>
    );
  }
  return (
    <div className={`msg assistant${message.error ? ' errored' : ''}`} title={time}>
      <div className="bubble">
        {message.text && <Markdown text={message.text} />}
        {message.pending && <span className="caret" aria-hidden="true" />}
        {message.pending && !message.text && <span className="sr-only">Conductor is writing</span>}
        <ToolCalls message={message} />
        {message.error && (
          <p className="msg-error">
            <AlertTriangle size={13} aria-hidden="true" /> {message.error}
          </p>
        )}
      </div>
      {message.costUsd !== undefined && <div className="msg-meta">{formatCost(message.costUsd)}</div>}
    </div>
  );
}

export function ChatView({ chat }: { chat: Chat }) {
  const now = useStore((s) => s.now);
  const upsertChat = useStore((s) => s.upsertChat);
  const removeChat = useStore((s) => s.removeChat);
  const selectWorkflow = useStore((s) => s.selectWorkflow);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const stickToBottom = useRef(true);

  const idle = chat.status === 'idle' && !sending;
  const canSend = idle && text.trim().length > 0;

  // Follow new output unless the user scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [chat.messages]);

  // Auto-grow the composer up to MAX_LINES.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_LINES * LINE_HEIGHT + 14)}px`;
  }, [text]);

  const onScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const send = async () => {
    const api = bridge();
    const value = text.trim();
    if (!api || !canSend) return;
    setSending(true);
    setError(undefined);
    stickToBottom.current = true;
    try {
      const updated = await api.sendChat({ chatId: chat.id, text: value });
      upsertChat(updated);
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  };

  const stop = async () => {
    const api = bridge();
    if (!api) return;
    setBusy(true);
    try {
      const updated = await api.cancelChat(chat.id);
      if (updated) upsertChat(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    const api = bridge();
    if (!api) return;
    if (!window.confirm(`Delete chat "${chat.title}"? Workflows it started are kept.`)) return;
    setBusy(true);
    try {
      await api.deleteChat(chat.id);
      removeChat(chat.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="chat-view" role="region" aria-label="Chat">
      <div className="wf-header">
        <div className="wf-heading">
          <div className="wf-name">
            {chat.title}
            <StatusLine status={chat.status} />
          </div>
          <div className="wf-meta">
            <span className="mono" title={chat.cwd}>
              <FolderOpen size={11} aria-hidden="true" /> {chat.cwd}
            </span>
            <span>Updated {formatRelative(chat.updatedAt, now)}</span>
          </div>
        </div>
        <div className="wf-actions">
          <button type="button" className="btn" disabled={busy} onClick={() => void remove()} title="Delete this chat">
            <Trash2 size={13} aria-hidden="true" /> Delete
          </button>
        </div>
      </div>

      <div className="chat-messages" ref={listRef} onScroll={onScroll} aria-live="polite">
        {chat.messages.length === 0 ? (
          <div className="chat-empty">
            <MessageSquare size={22} aria-hidden="true" />
            <p>Ask about this project or tell the conductor what to build. It delegates to your agents.</p>
            <div className="chat-examples">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  className="chip chat-example"
                  onClick={() => {
                    setText(example);
                    inputRef.current?.focus();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : (
          chat.messages.map((message) => <MessageRow key={message.id} message={message} onOpenWorkflow={selectWorkflow} />)
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        {error && <p className="error-text small chat-error">{error}</p>}
        <div className="chat-composer-row">
          <textarea
            ref={inputRef}
            id="chat-input"
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') e.currentTarget.blur();
              else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={!idle}
            placeholder={idle ? 'Message the conductor (Enter to send, Shift+Enter for a new line)' : 'Wait for the conductor to finish'}
            aria-label="Message"
            spellCheck
          />
          {chat.status === 'thinking' ? (
            <button type="button" className="btn" disabled={busy} onClick={() => void stop()} title="Stop the conductor">
              <Square size={13} aria-hidden="true" /> Stop
            </button>
          ) : (
            <button type="submit" className="btn primary" disabled={!canSend} title="Send (Enter)">
              {sending ? <Loader2 size={13} className="spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />} Send
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
