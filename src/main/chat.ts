import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendMessage, buildConductorPrompt, createChat, extractDirectives, permissionArgs, updateMessage, workflowEventText, workflowHandback } from '../core';
import type { Chat, ChatCreateRequest, ChatMessage, ChatToolCall, Settings, WorkflowRun } from '../shared/types';
import { killClaude, runClaude } from './claude-process';
import { resolveClaudeBinary, type Orchestrator } from './orchestrator';

export interface ChatEvents {
  chat: [Chat];
}

const CONDUCTOR_MAX_TURNS = 25;
const MAX_TOOL_CALLS_SHOWN = 40;

/**
 * One conductor conversation per chat: a read-only Claude Code session that
 * answers directly or delegates to the orchestrator through fenced directives.
 * Results of delegated workflows are fed back into the same session.
 */
export class ChatService extends EventEmitter<ChatEvents> {
  private chats = new Map<string, Chat>();
  private processes = new Map<string, ChildProcess>();

  constructor(
    private readonly userDataDir: string,
    private settings: Settings,
    private readonly orchestrator: Orchestrator,
  ) {
    super();
    this.load();
    orchestrator.on('workflow', (workflow) => this.onWorkflow(workflow));
  }

  updateSettings(next: Settings): void {
    this.settings = next;
  }

  list(): Chat[] {
    return [...this.chats.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  create(request: ChatCreateRequest): Chat {
    if (!request.cwd || !existsSync(request.cwd)) throw new Error('Working directory does not exist');
    const chat = createChat({ id: randomUUID(), cwd: request.cwd, sessionId: randomUUID(), now: Date.now(), ...(request.title ? { title: request.title } : {}) });
    return this.commit(chat);
  }

  delete(id: string): void {
    this.cancel(id);
    this.chats.delete(id);
    try {
      rmSync(this.chatPath(id), { force: true });
    } catch (error) {
      console.warn('[chat] failed to delete', id, error);
    }
  }

  cancel(id: string): Chat | undefined {
    const chat = this.chats.get(id);
    const child = this.processes.get(id);
    if (child) {
      this.processes.delete(id);
      killClaude(child);
    }
    if (!chat) return undefined;
    if (chat.status === 'idle') return chat;
    const pending = chat.messages.find((m) => m.pending);
    const now = Date.now();
    let next = pending ? updateMessage(chat, pending.id, { pending: false, error: 'Cancelled' }, now) : chat;
    next = { ...next, status: 'idle', sessionStarted: next.sessionStarted || !!pending, updatedAt: now };
    return this.commit(next);
  }

  /** Send a user message. The reply streams through `chat` events. */
  send(id: string, text: string): Chat {
    const chat = this.chats.get(id);
    if (!chat) throw new Error('Chat not found');
    const trimmed = text.trim();
    if (!trimmed) throw new Error('Message is empty');
    if (chat.status === 'thinking') throw new Error('The conductor is still replying');
    const now = Date.now();
    const withUser = appendMessage(chat, { id: randomUUID(), kind: 'user', text: trimmed, at: now });
    return this.ask(withUser, trimmed);
  }

  stop(): void {
    for (const id of [...this.processes.keys()]) this.cancel(id);
  }

  /* ---------- internals ---------- */

  /** Run one conductor turn on `prompt`; `chat` already holds whatever message the user sees. */
  private ask(chat: Chat, prompt: string): Chat {
    const binary = resolveClaudeBinary(this.settings.claudeBinary);
    if (!binary) throw new Error('Claude Code CLI not found. Install it or set its path in Settings.');
    const assistantId = randomUUID();
    const started = appendMessage({ ...chat, status: 'thinking' }, { id: assistantId, kind: 'assistant', text: '', at: Date.now(), pending: true, toolCalls: [] });
    this.commit(started);

    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--max-turns', String(CONDUCTOR_MAX_TURNS), ...permissionArgs({ permission: 'read-only' })];
    if (chat.sessionStarted) args.push('--resume', chat.sessionId);
    else args.push('--session-id', chat.sessionId, '--append-system-prompt', buildConductorPrompt(this.orchestrator.rolesList(), this.orchestrator.templatesList()));

    const toolCalls: ChatToolCall[] = [];
    let liveText = '';
    let child: ChildProcess;
    try {
      child = runClaude(binary, args, chat.cwd, {
        onSignal: (signal) => {
          const current = this.chats.get(chat.id);
          if (!current || this.processes.get(chat.id) !== child) return;
          if (signal.kind === 'assistant-text') {
            liveText = signal.text;
            this.push(updateMessage(current, assistantId, { text: liveText }, Date.now()), false);
          } else if (signal.kind === 'tool-call') {
            if (toolCalls.length < MAX_TOOL_CALLS_SHOWN) toolCalls.push({ name: signal.name, summary: signal.summary });
            this.push(updateMessage(current, assistantId, { toolCalls: [...toolCalls] }, Date.now()), false);
          }
        },
        onError: (error) => this.finish(chat.id, assistantId, { error: `Could not start Claude Code: ${error.message}` }, child),
        onExit: ({ code, result, stderr }) => {
          if (result && !result.isError) {
            this.finish(chat.id, assistantId, { text: result.text.trim() || liveText.trim(), ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}) }, child);
            return;
          }
          const reason = result?.isError ? result.text || 'Claude Code reported an error' : `Claude Code exited with code ${code ?? 'unknown'}`;
          this.finish(chat.id, assistantId, { text: liveText.trim(), error: stderr ? `${reason}\n${stderr.split('\n').slice(-3).join('\n')}` : reason }, child);
        },
      });
    } catch (error) {
      const failed = updateMessage(started, assistantId, { pending: false, error: error instanceof Error ? error.message : String(error) }, Date.now());
      return this.commit({ ...failed, status: 'idle' });
    }
    this.processes.set(chat.id, child);
    return started;
  }

  private finish(chatId: string, assistantId: string, outcome: { text?: string; error?: string; costUsd?: number }, child: ChildProcess): void {
    if (this.processes.get(chatId) !== child) return; // cancelled or superseded
    this.processes.delete(chatId);
    const chat = this.chats.get(chatId);
    if (!chat) return;
    const now = Date.now();
    const { text, directives, problems } = extractDirectives(outcome.text ?? '');
    const patch: Partial<ChatMessage> = { pending: false, text };
    if (outcome.costUsd !== undefined) patch.costUsd = outcome.costUsd;
    const errors = [outcome.error, ...problems].filter((e): e is string => !!e);
    if (errors.length) patch.error = errors.join('\n');
    let next: Chat = { ...updateMessage(chat, assistantId, patch, now), sessionStarted: true, status: 'idle' };

    for (const directive of directives) {
      try {
        const workflow = this.orchestrator.start({ goal: directive.goal, cwd: chat.cwd, chatId: chat.id, ...(directive.templateId ? { templateId: directive.templateId } : {}), ...(directive.roleIds ? { roleIds: directive.roleIds } : {}), ...(directive.name ? { name: directive.name } : {}) });
        next = appendMessage(next, { id: randomUUID(), kind: 'event', text: `Started workflow "${workflow.name}".`, at: Date.now(), workflowId: workflow.id });
        next = { ...next, status: 'waiting-workflow' };
      } catch (error) {
        next = appendMessage(next, { id: randomUUID(), kind: 'event', text: `Could not start workflow: ${error instanceof Error ? error.message : String(error)}`, at: Date.now(), error: 'workflow' });
      }
    }
    this.commit(next);
  }

  /** A delegated workflow ended: tell the conductor so it can report back. */
  private onWorkflow(workflow: WorkflowRun): void {
    if (!workflow.chatId || workflow.status === 'running') return;
    const chat = this.chats.get(workflow.chatId);
    if (!chat || chat.status !== 'waiting-workflow') return;
    if (chat.messages.some((m) => m.workflowId === workflow.id && m.kind === 'event' && m.text.startsWith('Workflow "'))) return; // already handled
    const now = Date.now();
    const withEvent = appendMessage(chat, { id: randomUUID(), kind: 'event', text: workflowEventText(workflow), at: now, workflowId: workflow.id });
    try {
      this.ask(withEvent, workflowHandback(workflow, this.orchestrator.rolesList()));
    } catch (error) {
      this.commit({ ...withEvent, status: 'idle', messages: [...withEvent.messages, { id: randomUUID(), kind: 'event', text: error instanceof Error ? error.message : String(error), at: Date.now(), error: 'conductor' }] });
    }
  }

  private push(chat: Chat, persist: boolean): void {
    this.chats.set(chat.id, chat);
    if (persist) this.persist(chat);
    this.emit('chat', chat);
  }

  private commit(chat: Chat): Chat {
    this.push(chat, true);
    return chat;
  }

  private chatsDir(): string {
    return join(this.userDataDir, 'chats');
  }

  private chatPath(id: string): string {
    return join(this.chatsDir(), `${id}.json`);
  }

  private persist(chat: Chat): void {
    try {
      mkdirSync(this.chatsDir(), { recursive: true });
      writeFileSync(this.chatPath(chat.id), JSON.stringify(chat, null, 2));
    } catch (error) {
      console.error('[chat] failed to persist', error);
    }
  }

  private load(): void {
    const dir = this.chatsDir();
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Chat;
        if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.messages)) continue;
        // A reply in flight when the app closed cannot be resumed; mark it and go idle.
        const now = Date.now();
        let chat = raw;
        for (const m of raw.messages) if (m.pending) chat = updateMessage(chat, m.id, { pending: false, error: 'AgentLens was closed while the conductor was replying' }, now);
        if (chat.status === 'thinking') chat = { ...chat, status: 'idle', sessionStarted: true };
        this.chats.set(chat.id, chat);
        if (chat !== raw) this.persist(chat);
      } catch (error) {
        console.warn('[chat] skipping unreadable chat', name, error);
      }
    }
  }
}
