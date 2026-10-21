import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DEFAULT_TEMPLATES, applyEvent, createWorkflow, markInterrupted, mergeRoles, nextPendingStep, parseStreamLine, stepArgs, workflowName, type WorkflowEvent } from '../core';
import type { OrchestratorConfig, RoleDefinition, Settings, WorkflowRun, WorkflowStartRequest, WorkflowTemplate } from '../shared/types';

export interface OrchestratorEvents {
  workflow: [WorkflowRun];
}

const MAX_LIVE_TEXT = 600;

/** Where the Claude Code CLI usually lives when the app is launched without a shell PATH. */
function candidateBinaries(): string[] {
  const home = homedir();
  const fromPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, process.platform === 'win32' ? 'claude.cmd' : 'claude'));
  return [
    ...fromPath,
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    join(home, '.npm-global', 'bin', 'claude'),
    join(home, 'AppData', 'Roaming', 'npm', 'claude.cmd'),
  ];
}

export function resolveClaudeBinary(configured: string | undefined): string | undefined {
  if (configured?.trim()) return existsSync(configured.trim()) ? configured.trim() : undefined;
  return candidateBinaries().find((p) => existsSync(p));
}

/**
 * Runs role-based workflows by spawning headless Claude Code sessions, one per
 * step, and hands each step's output to the next role. State lives in
 * <userData>/workflows/*.json so finished workflows survive restarts.
 */
export class Orchestrator extends EventEmitter<OrchestratorEvents> {
  private workflows = new Map<string, WorkflowRun>();
  private processes = new Map<string, ChildProcess>();
  private roles: RoleDefinition[] = [];
  private roleProblems: string[] = [];
  private templates: WorkflowTemplate[] = DEFAULT_TEMPLATES;

  constructor(
    private readonly userDataDir: string,
    private settings: Settings,
  ) {
    super();
    this.loadRoles();
    this.loadWorkflows();
  }

  updateSettings(next: Settings): void {
    this.settings = next;
  }

  config(): OrchestratorConfig {
    const claudeBinary = resolveClaudeBinary(this.settings.claudeBinary);
    return { roles: this.roles, templates: this.templates, ...(claudeBinary ? { claudeBinary } : {}) };
  }

  roleProblemsList(): string[] {
    return this.roleProblems;
  }

  list(): WorkflowRun[] {
    return [...this.workflows.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  start(request: WorkflowStartRequest): WorkflowRun {
    const goal = request.goal?.trim();
    if (!goal) throw new Error('Describe what the workflow should achieve');
    if (!request.cwd || !existsSync(request.cwd)) throw new Error('Working directory does not exist');
    const binary = resolveClaudeBinary(this.settings.claudeBinary);
    if (!binary) throw new Error('Claude Code CLI not found. Install it or set its path in Settings.');

    const template = request.templateId ? this.templates.find((t) => t.id === request.templateId) : undefined;
    const roleIds = request.roleIds?.length ? request.roleIds : template?.roleIds;
    if (!roleIds?.length) throw new Error('Pick a template or at least one role');
    const roles = roleIds.map((id) => {
      const role = this.roles.find((r) => r.id === id);
      if (!role) throw new Error(`Unknown role "${id}"`);
      return role;
    });

    const workflow = createWorkflow({
      id: randomUUID(),
      goal,
      cwd: request.cwd,
      roles,
      ...(template ? { templateId: template.id } : {}),
      name: request.name?.trim() || workflowName(goal, template),
      sessionIds: roles.map(() => randomUUID()),
      now: Date.now(),
    });
    this.commit(workflow);
    this.advance(workflow.id, binary);
    return workflow;
  }

  cancel(id: string): WorkflowRun | undefined {
    const workflow = this.workflows.get(id);
    if (!workflow || workflow.status !== 'running') return workflow;
    const child = this.processes.get(id);
    if (child) {
      this.processes.delete(id);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
      }, 3000).unref();
    }
    return this.commit(applyEvent(workflow, { type: 'cancelled', at: Date.now() }, this.roles));
  }

  delete(id: string): void {
    const workflow = this.workflows.get(id);
    if (!workflow) return;
    if (workflow.status === 'running') this.cancel(id);
    this.workflows.delete(id);
    try {
      rmSync(this.workflowPath(id), { force: true });
    } catch (error) {
      console.warn('[orchestrator] failed to delete', id, error);
    }
  }

  stop(): void {
    for (const id of [...this.processes.keys()]) this.cancel(id);
  }

  /* ---------- internals ---------- */

  private advance(id: string, binary: string): void {
    const workflow = this.workflows.get(id);
    if (!workflow) return;
    const index = nextPendingStep(workflow);
    if (index === undefined) return;
    const step = workflow.steps[index];
    const role = step && this.roles.find((r) => r.id === step.roleId);
    if (!step || !role) {
      this.commit(applyEvent(workflow, { type: 'step-errored', stepIndex: index, at: Date.now(), error: `Role "${step?.roleId}" no longer exists` }, this.roles));
      return;
    }
    this.commit(applyEvent(workflow, { type: 'step-started', stepIndex: index, at: Date.now() }, this.roles));
    this.runStep(id, index, role, binary);
  }

  private runStep(id: string, index: number, role: RoleDefinition, binary: string): void {
    const workflow = this.workflows.get(id);
    const step = workflow?.steps[index];
    if (!workflow || !step) return;

    // A Claude Code session refuses to start inside another one; the app may have been launched from a terminal session.
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    let child: ChildProcess;
    try {
      child = spawn(binary, stepArgs(role, step.sessionId, step.prompt), { cwd: workflow.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      this.fail(id, index, error instanceof Error ? error.message : String(error));
      return;
    }
    this.processes.set(id, child);

    let buffer = '';
    let lastText = '';
    let result: { isError: boolean; text: string; costUsd?: number; turns?: number } | undefined;
    let stderr = '';
    const handle = (line: string) => {
      for (const signal of parseStreamLine(line)) {
        if (signal.kind === 'assistant-text') {
          lastText = signal.text;
          this.progress(id, index, { liveText: signal.text.length > MAX_LIVE_TEXT ? signal.text.slice(0, MAX_LIVE_TEXT) + '…' : signal.text });
        } else if (signal.kind === 'tool-call') {
          this.progress(id, index, { currentAction: signal.summary });
        } else if (signal.kind === 'result') {
          result = signal;
        }
      }
    };
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        handle(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on('error', (error) => {
      if (this.processes.get(id) !== child) return;
      this.processes.delete(id);
      this.fail(id, index, `Could not start Claude Code: ${error.message}`);
    });
    child.on('close', (code) => {
      if (this.processes.get(id) !== child) return; // cancelled
      this.processes.delete(id);
      if (buffer.trim()) handle(buffer);
      const current = this.workflows.get(id);
      if (!current || current.steps[index]?.status !== 'running') return;
      if (result && !result.isError) {
        const output = result.text.trim() || lastText.trim();
        const finished: WorkflowEvent = { type: 'step-finished', stepIndex: index, at: Date.now(), output };
        if (result.costUsd !== undefined) finished.costUsd = result.costUsd;
        if (result.turns !== undefined) finished.turns = result.turns;
        this.commit(applyEvent(current, finished, this.roles));
        this.advance(id, binary);
        return;
      }
      const reason = result?.isError ? result.text || 'Claude Code reported an error' : `Claude Code exited with code ${code ?? 'unknown'}`;
      const detail = stderr.trim() ? `${reason}\n${stderr.trim().split('\n').slice(-5).join('\n')}` : reason;
      this.fail(id, index, detail);
    });
  }

  private progress(id: string, index: number, patch: { liveText?: string; currentAction?: string }): void {
    const workflow = this.workflows.get(id);
    if (!workflow) return;
    const event: WorkflowEvent = { type: 'step-progress', stepIndex: index, ...patch };
    const next = applyEvent(workflow, event, this.roles);
    this.workflows.set(id, next);
    this.emit('workflow', next); // not persisted: live text is transient
  }

  private fail(id: string, index: number, error: string): void {
    const workflow = this.workflows.get(id);
    if (!workflow) return;
    this.commit(applyEvent(workflow, { type: 'step-errored', stepIndex: index, at: Date.now(), error }, this.roles));
  }

  private commit(workflow: WorkflowRun): WorkflowRun {
    this.workflows.set(workflow.id, workflow);
    this.persist(workflow);
    this.emit('workflow', workflow);
    return workflow;
  }

  private workflowsDir(): string {
    return join(this.userDataDir, 'workflows');
  }

  private workflowPath(id: string): string {
    return join(this.workflowsDir(), `${id}.json`);
  }

  private persist(workflow: WorkflowRun): void {
    try {
      mkdirSync(this.workflowsDir(), { recursive: true });
      writeFileSync(this.workflowPath(workflow.id), JSON.stringify(workflow, null, 2));
    } catch (error) {
      console.error('[orchestrator] failed to persist workflow', error);
    }
  }

  private loadWorkflows(): void {
    const dir = this.workflowsDir();
    if (!existsSync(dir)) return;
    const now = Date.now();
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(readFileSync(join(dir, name), 'utf8')) as WorkflowRun;
        if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.steps)) continue;
        const workflow = markInterrupted(raw, now);
        this.workflows.set(workflow.id, workflow);
        if (workflow !== raw) this.persist(workflow);
      } catch (error) {
        console.warn('[orchestrator] skipping unreadable workflow', name, error);
      }
    }
  }

  /** Users can add or override roles in <userData>/roles.json: a JSON array of RoleDefinition. */
  private loadRoles(): void {
    const file = join(this.userDataDir, 'roles.json');
    let custom: unknown;
    if (existsSync(file)) {
      try {
        custom = JSON.parse(readFileSync(file, 'utf8'));
      } catch (error) {
        this.roleProblems = [`roles.json could not be parsed: ${error instanceof Error ? error.message : String(error)}`];
      }
    }
    const merged = mergeRoles(custom);
    this.roles = merged.roles;
    this.roleProblems = [...this.roleProblems, ...merged.problems];
    for (const problem of this.roleProblems) console.warn('[orchestrator]', problem);
  }
}
