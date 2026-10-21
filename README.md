# AgentLens

A local desktop dashboard that shows what your Claude Code and Codex agents are doing right now: which subagents the main agent spawned, what task each one was given, what it is working on this second, how long it has been running, and what it costs.

Everything is read from the session logs already on your disk. Nothing leaves your machine.

![Topology view](docs/screenshots/topology.png)
*Topology: the main agent and its subagents, each card showing the task, status, and current action.*

## Why

Agent harnesses write detailed JSONL transcripts, but they are hard to read and say nothing about the overall shape of a run. AgentLens turns them into a live picture:

- **Real task descriptions.** Subagent cards show the `description` and prompt the parent gave them, not "Tool result".
- **A "Currently:" line in plain words.** "Editing src/App.tsx", "Running npm test", "Searching for 'auth'".
- **Projects, not launch folders.** Runs are grouped by the repository they worked in, with a title taken from your first prompt.
- **Parallelism you can see.** A Gantt timeline shows when each agent started and finished.

## Features

| Area | What you get |
| --- | --- |
| Sidebar | Runs grouped by project with run count and last-active time, search, filters by project/status/provider, an Active-only toggle, lazy token totals |
| Topology | Graph of agents with status colors and icons, animated edges only on running agents, auto-fit |
| Agent cards | Task title, status (Running / Idle / Finished / Errored), "Now:" item from the todo list, current action, elapsed time, tokens, tool count, model badge |
| Side panel | Task and full prompt, Timeline, Tool calls with result previews, Files touched, Token breakdown with per-model cost |
| Timeline | Horizontal Gantt of agent lifetimes with spawn markers and a now line |
| Settings | Session directories, light/dark/system theme, desktop notifications, idle window, editable per-model pricing |
| Keyboard | `/` search, `j`/`k` move, `Enter` open, `Esc` close, `1`/`2` views, `?` help |

![Side panel](docs/screenshots/side-panel.png)
*Side panel on a subagent: the prompt it received, its tool calls, and token cost.*

![Timeline](docs/screenshots/timeline.png)
*Timeline: four subagents working in parallel while the main agent waits.*

## Install

Unsigned builds for macOS, Windows, and Linux are published on the [Releases](https://github.com/aymanlaassel/agentlens/releases) page. Because they are not code-signed, the OS will warn you on first launch:

- **macOS:** right-click the app → Open, then confirm. Or run `xattr -dr com.apple.quarantine /Applications/AgentLens.app`.
- **Windows:** in the SmartScreen dialog choose *More info* → *Run anyway*.
- **Linux:** `chmod +x AgentLens-*.AppImage && ./AgentLens-*.AppImage`, or install the `.deb`.

### Run from source

Requires Node.js 22 or newer.

```sh
git clone https://github.com/aymanlaassel/agentlens.git
cd agentlens
npm install
npm run dev
```

### Build your own installers

```sh
npm run dist          # current platform
npm run dist:mac      # dmg + zip, arm64 and x64
npm run dist:win      # nsis installer + portable exe
npm run dist:linux    # AppImage + deb
```

Output lands in `release/`. Builds are unsigned by default (`identity: null` in `electron-builder.yml`). To sign, set the usual `CSC_LINK` / `CSC_KEY_PASSWORD` environment variables and remove that line.

## How session discovery works

AgentLens reads two directory trees. Both are configurable in Settings.

| Provider | Default location | What is read |
| --- | --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects` | `<project>/<session>.jsonl` for the main agent, `<project>/<session>/subagents/agent-*.jsonl` and `.meta.json` for subagents |
| Codex | `$CODEX_HOME/sessions` or `~/.codex/sessions` | `YYYY/MM/DD/rollout-*.jsonl` |

On startup only the first and last chunks of each file are read, which is enough to list a run with its title, project, branch, and status. A run is parsed in full when you select it or when its token total scrolls into view. A file watcher re-parses the open run as the agent writes to it and refreshes the others cheaply.

How the pieces are derived:

- **Project name:** the git repository root containing the session's working directory, otherwise the last path segment. Codex sessions use the repository URL when present. Sessions started by scheduled Claude jobs are grouped under "Claude scheduled jobs".
- **Run title:** the harness-generated title when one exists, otherwise your first prompt trimmed to about 60 characters.
- **Subagent task:** the `description` and `prompt` from the parent's `Agent` (or legacy `Task`) tool call, matched through the subagent's `.meta.json` or, for older logs, by prompt text.
- **Status:** *Running* while the log changed within the idle window (45 s by default), *Finished* when the subagent handed back or the session is old, *Errored* on an API error or a failing final tool call, *Idle* otherwise.
- **Cost:** token counts from the logs times the per-model prices in Settings. Models without a price show "Set pricing" instead of a guess.

## Privacy

AgentLens is local-only software.

- It reads files under the two configured directories and nothing else.
- It makes no network requests. There is no telemetry, crash reporting, or update check.
- Prompts, tool results, and file paths are shown in the UI and are never written anywhere except the app's own `settings.json` (which holds only your preferences).

If you share screenshots or bug reports, scrub them first: transcripts frequently contain secrets.

## Development

```sh
npm run dev         # Vite + Electron with live reload
npm run typecheck   # tsc for renderer and main
npm run lint        # eslint
npm test            # vitest, fixtures in tests/fixtures
npm run build       # production renderer + main bundles
```

Layout:

```
src/core       pure parsers and derivations (no Electron), fully unit tested
src/main       Electron main: discovery, watcher, IPC, settings
src/preload    typed context bridge
src/renderer   React UI
src/shared     types and IPC channel names
tests          vitest suites and small synthetic JSONL fixtures
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to add a provider or extend the parser.

## Acknowledgements

The idea of visualizing agent session logs as a graph was inspired by [donvito/agent-monitor](https://github.com/donvito/agent-monitor). AgentLens is an independent implementation written from scratch and shares no code with it.

## License

[MIT](LICENSE) © 2026 Ayman Laassel
