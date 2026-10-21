import { AlertTriangle, ArrowRight, FolderOpen, Play, Plus, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { PERMISSION_HELP, PERMISSION_LABEL } from '../../core/roles';
import type { RoleDefinition, WorkflowStartRequest } from '../../shared/types';
import { bridge } from '../lib/bridge';
import { useStore } from '../store';

const CWD_KEY = 'agentlens.workflowCwd';

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

function RoleChip({ role, onRemove }: { role: RoleDefinition; onRemove?: () => void }) {
  return (
    <span className={`chip role-chip perm-${role.permission}`} title={`${role.description}\n${PERMISSION_HELP[role.permission]}`}>
      <span>{role.name}</span>
      <span className="perm">{PERMISSION_LABEL[role.permission]}</span>
      {onRemove && (
        <button type="button" onClick={onRemove} aria-label={`Remove ${role.name}`} className="chip-remove">
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </span>
  );
}

/** Mounted only while open. Starts a workflow from a template or a custom role sequence. */
export function WorkflowDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const orchestrator = useStore((s) => s.orchestrator);
  const selectedRunId = useStore((s) => s.selectedRunId);
  const selectedRun = useStore((s) => s.snapshot?.runs.find((r) => r.id === selectedRunId));
  const upsertWorkflow = useStore((s) => s.upsertWorkflow);
  const selectWorkflow = useStore((s) => s.selectWorkflow);

  const templates = useMemo(() => orchestrator?.templates ?? [], [orchestrator]);
  const roles = useMemo(() => orchestrator?.roles ?? [], [orchestrator]);
  const roleById = useMemo(() => new Map(roles.map((r) => [r.id, r])), [roles]);

  const [mode, setMode] = useState<'template' | 'custom'>('template');
  const [chosenTemplateId, setTemplateId] = useState<string>('');
  const [customRoleIds, setCustomRoleIds] = useState<string[]>([]);
  const [chosenRoleToAdd, setRoleToAdd] = useState<string>('');
  // Fall back to the first option until the user picks one; config may arrive after mount.
  const templateId = chosenTemplateId || (templates[0]?.id ?? '');
  const roleToAdd = chosenRoleToAdd || (roles[0]?.id ?? '');
  const [goal, setGoal] = useState('');
  const [cwd, setCwd] = useState(() => selectedRun?.cwd || selectedRun?.projectPath || readStoredCwd());
  const [name, setName] = useState('');
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  const template = templates.find((t) => t.id === templateId);
  const chainIds = mode === 'template' ? (template?.roleIds ?? []) : customRoleIds;
  const chain = chainIds.map((id) => roleById.get(id)).filter((r): r is RoleDefinition => !!r);
  const hasFull = chain.some((r) => r.permission === 'full');
  const binaryMissing = !orchestrator?.claudeBinary;
  const canStart = !binaryMissing && !starting && goal.trim().length > 0 && cwd.trim().length > 0 && chain.length > 0;

  const pick = async () => {
    const chosen = await bridge()?.pickDirectory(cwd || undefined);
    if (chosen) setCwd(chosen);
  };

  const start = async () => {
    const api = bridge();
    if (!api || !canStart) return;
    setStarting(true);
    setError(undefined);
    const request: WorkflowStartRequest = {
      goal: goal.trim(),
      cwd: cwd.trim(),
      ...(mode === 'template' && template ? { templateId: template.id } : { roleIds: chainIds }),
      ...(name.trim() ? { name: name.trim() } : {}),
    };
    try {
      const workflow = await api.startWorkflow(request);
      storeCwd(request.cwd);
      upsertWorkflow(workflow);
      selectWorkflow(workflow.id);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog workflow-dialog" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()} aria-labelledby="workflow-title">
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          void start();
        }}
      >
        <h2 id="workflow-title">New workflow</h2>
        <p className="muted small">Each role runs as its own headless Claude Code session in the working directory. The output of one role is handed to the next.</p>

        {binaryMissing && (
          <p className="error-text wf-warning">
            <AlertTriangle size={14} aria-hidden="true" /> Claude Code CLI not found. Set its path in Settings.
          </p>
        )}

        <fieldset>
          <legend>Roles</legend>
          <div className="radio-row" role="radiogroup" aria-label="Role selection mode">
            <label className="chip" aria-pressed={mode === 'template'}>
              <input type="radio" name="wf-mode" value="template" checked={mode === 'template'} onChange={() => setMode('template')} className="sr-only" />
              Template
            </label>
            <label className="chip" aria-pressed={mode === 'custom'}>
              <input type="radio" name="wf-mode" value="custom" checked={mode === 'custom'} onChange={() => setMode('custom')} className="sr-only" />
              Custom sequence
            </label>
          </div>

          {mode === 'template' ? (
            <>
              <label className="field">
                <span>Template</span>
                <select value={templateId} onChange={(e) => setTemplateId(e.target.value)} aria-label="Workflow template">
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {template && <p className="muted small">{template.description}</p>}
            </>
          ) : (
            <div className="field-row">
              <select value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value)} aria-label="Role to add">
                {roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name} · {PERMISSION_LABEL[r.permission]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" disabled={!roleToAdd} onClick={() => roleToAdd && setCustomRoleIds((ids) => [...ids, roleToAdd])}>
                <Plus size={14} aria-hidden="true" /> Add step
              </button>
            </div>
          )}

          <div className="role-chain" aria-label="Role sequence">
            {chain.length === 0 && <span className="muted small">No roles selected.</span>}
            {chain.map((role, index) => (
              <span key={`${role.id}-${index}`} className="role-chain-item">
                {index > 0 && <ArrowRight size={13} aria-hidden="true" className="muted" />}
                <RoleChip role={role} {...(mode === 'custom' ? { onRemove: () => setCustomRoleIds((ids) => ids.filter((_, i) => i !== index)) } : {})} />
              </span>
            ))}
          </div>
          {hasFull && (
            <p className="wf-warning">
              <AlertTriangle size={14} aria-hidden="true" /> This sequence includes a full-access role. {PERMISSION_HELP.full}
            </p>
          )}
        </fieldset>

        <fieldset>
          <legend>Task</legend>
          <label className="field">
            <span>Goal</span>
            <textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={4} placeholder="What should the team achieve?" aria-label="Workflow goal" />
          </label>
          <label className="field">
            <span>Working directory</span>
            <span className="field-row">
              <input type="text" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} placeholder="/path/to/project" />
              <button type="button" className="btn" onClick={() => void pick()} aria-label="Browse for working directory">
                <FolderOpen size={14} aria-hidden="true" />
              </button>
            </span>
          </label>
          <label className="field">
            <span>Name (optional)</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Defaults to the template and goal" />
          </label>
        </fieldset>

        {error && <p className="error-text">{error}</p>}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary" disabled={!canStart}>
            <Play size={14} aria-hidden="true" /> {starting ? 'Starting…' : 'Start'}
          </button>
        </div>
      </form>
    </dialog>
  );
}
