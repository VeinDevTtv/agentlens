import { spawn, type ChildProcess } from 'node:child_process';
import { parseStreamLine, type StreamSignal } from '../core';

export interface ClaudeRunHandlers {
  onSignal: (signal: StreamSignal) => void;
  /** Called once when the process ends. `result` is the last result signal seen, if any. */
  onExit: (info: { code: number | null; result: Extract<StreamSignal, { kind: 'result' }> | undefined; stderr: string }) => void;
  onError: (error: Error) => void;
}

/**
 * Spawn one headless Claude Code process and parse its stream-json output.
 * The environment markers of an enclosing Claude Code session are removed,
 * otherwise the CLI refuses to start when the app was launched from one.
 */
export function runClaude(binary: string, args: string[], cwd: string, handlers: ClaudeRunHandlers): ChildProcess {
  const env = { ...process.env };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  const child = spawn(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  let result: Extract<StreamSignal, { kind: 'result' }> | undefined;
  let done = false;

  const handle = (line: string) => {
    for (const signal of parseStreamLine(line)) {
      if (signal.kind === 'result') result = signal;
      handlers.onSignal(signal);
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
    if (done) return;
    done = true;
    handlers.onError(error);
  });
  child.on('close', (code) => {
    if (done) return;
    done = true;
    if (buffer.trim()) handle(buffer);
    handlers.onExit({ code, result, stderr: stderr.trim() });
  });
  return child;
}

/** Terminate a child politely, then forcefully. */
export function killClaude(child: ChildProcess): void {
  child.kill('SIGTERM');
  setTimeout(() => {
    if (child.exitCode === null && !child.killed) child.kill('SIGKILL');
  }, 3000).unref();
}
