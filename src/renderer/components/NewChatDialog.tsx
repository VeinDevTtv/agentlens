import { AlertTriangle, FolderOpen, MessageSquarePlus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ChatCreateRequest } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { useStore } from '../store';

const CWD_KEY = 'agentlens.chatCwd';

function readStoredCwd(): string {
  try {
    return localStorage.getItem(CWD_KEY) ?? '';
  } catch {
    return '';
  }
}

function storeCwd(cwd: string): void {
  try {
    localStorage.setItem(CWD_KEY, cwd);
  } catch {
    /* storage unavailable */
  }
}

/** Mounted only while open. Creates a conductor chat bound to a working directory. */
export function NewChatDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const selectedRun = useStore((s) => (s.selectedRunId ? s.snapshot?.runs.find((r) => r.id === s.selectedRunId) : undefined));
  const selectedChat = useStore((s) => (s.selectedChatId ? s.chats.find((c) => c.id === s.selectedChatId) : undefined));
  const binaryMissing = useStore((s) => !!s.orchestrator && !s.orchestrator.claudeBinary);
  const upsertChat = useStore((s) => s.upsertChat);
  const selectChat = useStore((s) => s.selectChat);

  const [cwd, setCwd] = useState(() => selectedRun?.cwd || selectedRun?.projectPath || selectedChat?.cwd || readStoredCwd());
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const canCreate = !creating && cwd.trim().length > 0;

  const pick = async () => {
    const chosen = await bridge()?.pickDirectory(cwd || undefined);
    if (chosen) setCwd(chosen);
  };

  const create = async () => {
    const api = bridge();
    if (!api || !canCreate) return;
    setCreating(true);
    setError(undefined);
    const request: ChatCreateRequest = { cwd: cwd.trim(), ...(title.trim() ? { title: title.trim() } : {}) };
    try {
      const chat = await api.createChat(request);
      storeCwd(request.cwd);
      upsertChat(chat);
      selectChat(chat.id);
      onClose();
      requestAnimationFrame(() => document.getElementById('chat-input')?.focus());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog chat-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="chat-dialog-title">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <h2 id="chat-dialog-title">New chat</h2>
        <p className="muted small">The conductor is a Claude Code session in this directory. It answers questions itself and starts workflows when there is work to delegate.</p>
        {binaryMissing && (
          <p className="error-text wf-warning">
            <AlertTriangle size={14} aria-hidden="true" /> Claude Code CLI not found. Set its path in Settings.
          </p>
        )}
        <label className="field">
          <span>Working directory</span>
          <span className="field-row">
            <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} placeholder="/path/to/project" autoFocus />
            <button type="button" className="btn" onClick={() => void pick()} aria-label="Browse for working directory">
              <FolderOpen size={14} aria-hidden="true" />
            </button>
          </span>
        </label>
        <label className="field">
          <span>Title (optional)</span>
          <input type="text" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to your first message" />
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canCreate}>
            <MessageSquarePlus size={14} aria-hidden="true" /> {creating ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
