import { ChevronDown, ChevronRight, Eye, EyeOff, Keyboard, MessageSquarePlus, Play, RefreshCw, Search, Settings as SettingsIcon, Telescope, X, Zap } from 'lucide-react';
import { useEffect, useMemo, useRef } from 'react';
import { totalTokens } from '../../core/tokens';
import type { Chat, ChatStatus, RunSummary, WorkflowRun, WorkflowStatus } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { formatCompact, formatRelative, shortModel } from '../lib/format';
import { groupByProject, matchesFilters, projectNames, sortRuns } from '../lib/selectors';
import { useStore, type StatusFilter } from '../store';
import { STATUS_LABEL } from './StatusBadge';

function useLazyTokens(run: RunSummary, mergeRun: (run: RunSummary) => void) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (run.tokensLoaded || run.isEmpty) return;
    const api = bridge();
    const el = ref.current;
    if (!api || !el) return;
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      void api.loadRunTokens(run.id).then((updated) => {
        if (!cancelled && updated) mergeRun(updated);
      }).catch(() => undefined);
    });
    observer.observe(el);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [run.id, run.tokensLoaded, run.isEmpty, mergeRun]);
  return ref;
}

function RunRow({ run, selected, now, onSelect }: { run: RunSummary; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const mergeRun = useStore((s) => s.mergeRun);
  const ref = useLazyTokens(run, mergeRun);
  return (
    <button
      ref={ref}
      type="button"
      role="option"
      aria-selected={selected}
      className="run-row"
      data-run-id={run.id}
      onClick={() => onSelect(run.id)}
      title={`${run.title}\n${run.cwd}`}
    >
      <span className={`status-dot ${run.status}`} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span className="title">{run.title}</span>
        <span className="sub">
          <span className="sr-only">{STATUS_LABEL[run.status]}.</span>
          <span>{run.provider === 'claude' ? 'Claude Code' : 'Codex'}</span>
          {run.gitBranch && <span>· {run.gitBranch}</span>}
          {run.model && <span>· {shortModel(run.model)}</span>}
        </span>
      </span>
      <span className="right">
        <span>{formatRelative(run.lastActivityAt, now)}</span>
        {run.tokensLoaded && run.tokens ? (
          <span title={run.tokensStale ? 'Previously counted tokens. Open this run to refresh the total.' : 'Total tokens'} aria-label={run.tokensStale ? `${formatCompact(totalTokens(run.tokens))} tokens, awaiting refresh` : undefined}>
            {formatCompact(totalTokens(run.tokens))} tok{run.tokensStale ? ' · stale' : ''}
          </span>
        ) : run.isEmpty ? (
          <span>empty</span>
        ) : (
          <span className="skeleton" aria-label="Loading tokens" />
        )}
        {run.agentCount > 1 && <span>{run.agentCount} agents</span>}
      </span>
    </button>
  );
}

const WORKFLOW_DOT: Record<WorkflowStatus, string> = { running: 'running', finished: 'finished', errored: 'errored', cancelled: 'idle' };
const WORKFLOW_LABEL: Record<WorkflowStatus, string> = { running: 'Running', finished: 'Finished', errored: 'Errored', cancelled: 'Cancelled' };
const WORKFLOWS_GROUP = '__workflows';

function WorkflowRow({ workflow, selected, now, onSelect }: { workflow: WorkflowRun; selected: boolean; now: number; onSelect: (id: string) => void }) {
  const done = workflow.steps.filter((s) => s.status === 'finished').length;
  const running = workflow.steps.find((s) => s.status === 'running');
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      className="run-row workflow-row"
      data-workflow-id={workflow.id}
      onClick={() => onSelect(workflow.id)}
      title={`${workflow.name}\n${workflow.goal}\n${workflow.cwd}`}
    >
      <span className={`status-dot ${WORKFLOW_DOT[workflow.status]}`} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span className="title">{workflow.name}</span>
        <span className="sub">
          <span className="sr-only">{WORKFLOW_LABEL[workflow.status]}.</span>
          <span>Workflow</span>
          {running && <span>· {running.roleId}</span>}
        </span>
      </span>
      <span className="right">
        <span>{formatRelative(workflow.updatedAt, now)}</span>
        <span title="Finished steps">
          {done}/{workflow.steps.length} steps
        </span>
      </span>
    </button>
  );
}

const CHAT_DOT: Record<ChatStatus, string> = { thinking: 'running', 'waiting-workflow': 'idle', idle: 'finished' };
const CHAT_LABEL: Record<ChatStatus, string> = { thinking: 'Thinking', 'waiting-workflow': 'Waiting for workflow', idle: 'Idle' };
const CHATS_GROUP = '__chats';

function basename(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
}

function ChatRow({ chat, selected, now, onSelect }: { chat: Chat; selected: boolean; now: number; onSelect: (id: string) => void }) {
  return (
    <button type="button" role="option" aria-selected={selected} className="run-row chat-row" data-chat-id={chat.id} onClick={() => onSelect(chat.id)} title={`${chat.title}\n${chat.cwd}`}>
      <span className={`status-dot ${CHAT_DOT[chat.status]}`} aria-hidden="true" />
      <span style={{ minWidth: 0 }}>
        <span className="title">{chat.title}</span>
        <span className="sub">
          <span className="sr-only">{CHAT_LABEL[chat.status]}.</span>
          <span>{basename(chat.cwd)}</span>
        </span>
      </span>
      <span className="right">
        <span>{formatRelative(chat.updatedAt, now)}</span>
      </span>
    </button>
  );
}

export function Sidebar() {
  const snapshot = useStore((s) => s.snapshot);
  const workflows = useStore((s) => s.workflows);
  const selectedWorkflowId = useStore((s) => s.selectedWorkflowId);
  const selectWorkflow = useStore((s) => s.selectWorkflow);
  const setWorkflowDialogOpen = useStore((s) => s.setWorkflowDialogOpen);
  const chats = useStore((s) => s.chats);
  const selectedChatId = useStore((s) => s.selectedChatId);
  const selectChat = useStore((s) => s.selectChat);
  const setChatDialogOpen = useStore((s) => s.setChatDialogOpen);
  const search = useStore((s) => s.search);
  const setSearch = useStore((s) => s.setSearch);
  const projectFilter = useStore((s) => s.projectFilter);
  const setProjectFilter = useStore((s) => s.setProjectFilter);
  const statusFilter = useStore((s) => s.statusFilter);
  const setStatusFilter = useStore((s) => s.setStatusFilter);
  const activeOnly = useStore((s) => s.activeOnly);
  const toggleActiveOnly = useStore((s) => s.toggleActiveOnly);
  const showEmpty = useStore((s) => s.showEmpty);
  const toggleShowEmpty = useStore((s) => s.toggleShowEmpty);
  const collapsed = useStore((s) => s.collapsedProjects);
  const toggleProject = useStore((s) => s.toggleProject);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectRun = useStore((s) => s.selectRun);
  const providerFilter = useStore((s) => s.providerFilter);
  const setProviderFilter = useStore((s) => s.setProviderFilter);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setHelpOpen = useStore((s) => s.setHelpOpen);
  const now = useStore((s) => s.now);
  const allRuns = useMemo(() => snapshot?.runs ?? [], [snapshot]);
  const visible = useMemo(
    () => allRuns.filter((r) => matchesFilters(r, { search, projectFilter, statusFilter, providerFilter, activeOnly, showEmpty })).sort(sortRuns),
    [allRuns, search, projectFilter, statusFilter, providerFilter, activeOnly, showEmpty],
  );
  const groups = useMemo(() => groupByProject(visible), [visible]);
  const byId = useMemo(() => new Map(visible.map((r) => [r.id, r])), [visible]);
  const projects = useMemo(() => projectNames(allRuns.filter((r) => showEmpty || !r.isEmpty)), [allRuns, showEmpty]);
  const emptyCount = allRuns.filter((r) => r.isEmpty).length;
  const runningCount = allRuns.filter((r) => r.status === 'running').length;
  const hasProviders = new Set(allRuns.map((r) => r.provider)).size > 1;

  return (
    <aside className="sidebar" aria-label="Runs">
      <div className="sidebar-top">
        <div className="brand">
          <Telescope size={18} aria-hidden="true" /> AgentLens
          <span className="version">{runningCount > 0 ? `${runningCount} running` : ''}</span>
          <button type="button" className="btn small new-workflow" onClick={() => setWorkflowDialogOpen(true)} title="New workflow (n)">
            <Play size={12} aria-hidden="true" /> New workflow
          </button>
          <button type="button" className="btn small new-chat" onClick={() => setChatDialogOpen(true)} title="New chat (c)">
            <MessageSquarePlus size={12} aria-hidden="true" /> Chat
          </button>
        </div>
        <div className="search">
          <Search size={14} aria-hidden="true" />
          <input
            id="run-search"
            type="search"
            placeholder="Search runs, projects, branches"
            aria-label="Search runs"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') (e.target as HTMLInputElement).blur();
            }}
          />
          {!search && <kbd aria-hidden="true">/</kbd>}
        </div>
        <div className="filters">
          <button type="button" className="chip" aria-pressed={activeOnly} onClick={toggleActiveOnly} title="Show only running runs">
            <Zap size={12} aria-hidden="true" /> Active only
          </button>
          <select aria-label="Filter by project" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)}>
            <option value="all">All projects</option>
            {projects.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
          <select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}>
            <option value="all">Any status</option>
            {(Object.keys(STATUS_LABEL) as Array<keyof typeof STATUS_LABEL>).map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          {hasProviders && (
            <select aria-label="Filter by provider" value={providerFilter} onChange={(e) => setProviderFilter(e.target.value as 'all' | 'claude' | 'codex')}>
              <option value="all">All providers</option>
              <option value="claude">Claude Code</option>
              <option value="codex">Codex</option>
            </select>
          )}
          {(search || projectFilter !== 'all' || statusFilter !== 'all' || providerFilter !== 'all' || activeOnly) && (
            <button
              type="button"
              className="chip"
              onClick={() => {
                setSearch('');
                setProjectFilter('all');
                setStatusFilter('all');
                setProviderFilter('all');
                if (activeOnly) toggleActiveOnly();
              }}
              title="Clear filters"
            >
              <X size={12} aria-hidden="true" /> Clear
            </button>
          )}
        </div>
      </div>
      <div className="run-list" role="listbox" aria-label="Runs grouped by project" aria-activedescendant={selectedChatId ?? selectedWorkflowId ?? selectedRunId}>
        {chats.length > 0 && (
          <section className="project-group chats-group">
            <button type="button" className="project-header" onClick={() => toggleProject(CHATS_GROUP)} aria-expanded={!collapsed[CHATS_GROUP]} title="Conductor chats">
              {collapsed[CHATS_GROUP] ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <span className="name">Chats</span>
              <span className="meta">
                {chats.some((c) => c.status !== 'idle') && <span className="running-dot" title="A conductor is working" />}
                <span>{chats.length}</span>
              </span>
            </button>
            {!collapsed[CHATS_GROUP] && chats.map((c) => <ChatRow key={c.id} chat={c} now={now} selected={c.id === selectedChatId} onSelect={selectChat} />)}
          </section>
        )}
        {workflows.length > 0 && (
          <section className="project-group workflows-group">
            <button type="button" className="project-header" onClick={() => toggleProject(WORKFLOWS_GROUP)} aria-expanded={!collapsed[WORKFLOWS_GROUP]} title="Workflows started from AgentLens">
              {collapsed[WORKFLOWS_GROUP] ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
              <span className="name">Workflows</span>
              <span className="meta">
                {workflows.some((w) => w.status === 'running') && <span className="running-dot" title="A workflow is running" />}
                <span>{workflows.length}</span>
              </span>
            </button>
            {!collapsed[WORKFLOWS_GROUP] && workflows.map((w) => <WorkflowRow key={w.id} workflow={w} now={now} selected={w.id === selectedWorkflowId} onSelect={selectWorkflow} />)}
          </section>
        )}
        {visible.length === 0 && (
          <div className="empty-state" style={{ padding: '32px 12px' }}>
            <p>{allRuns.length === 0 ? 'No runs discovered yet.' : 'No runs match these filters.'}</p>
          </div>
        )}
        {groups.map((group) => {
          const isCollapsed = !!collapsed[group.name];
          return (
            <section key={group.name} className="project-group">
              <button type="button" className="project-header" onClick={() => toggleProject(group.name)} aria-expanded={!isCollapsed} title={group.path}>
                {isCollapsed ? <ChevronRight size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
                <span className="name">{group.name}</span>
                <span className="meta">
                  {group.runningCount > 0 && <span className="running-dot" title={`${group.runningCount} running`} />}
                  <span>{group.runIds.length}</span>
                  <span>{formatRelative(group.lastActivityAt, now)}</span>
                </span>
              </button>
              {!isCollapsed &&
                group.runIds.map((id) => {
                  const run = byId.get(id);
                  return run ? <RunRow key={id} run={run} now={now} selected={id === selectedRunId} onSelect={selectRun} /> : null;
                })}
            </section>
          );
        })}
      </div>
      <div className="sidebar-footer">
        {emptyCount > 0 && (
          <button type="button" onClick={toggleShowEmpty} title={showEmpty ? 'Hide empty sessions' : `Show ${emptyCount} empty sessions`} aria-pressed={showEmpty}>
            {showEmpty ? <EyeOff size={13} aria-hidden="true" /> : <Eye size={13} aria-hidden="true" />} {emptyCount} empty
          </button>
        )}
        <span className="spacer" />
        <button type="button" onClick={() => void bridge()?.rescan()} title="Rescan session directories" aria-label="Rescan">
          <RefreshCw size={13} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setHelpOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">
          <Keyboard size={13} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} title="Settings" aria-label="Settings">
          <SettingsIcon size={13} aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
