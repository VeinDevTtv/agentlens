# Changelog

## Unreleased

### Added

- Codex rollouts with native parent-thread metadata appear as one nested agent tree. Child tasks come from the parent's `spawn_agent` call; roles, per-agent transcripts, token totals, and the latest activity are retained.
- Codex delegation, messaging, waiting, resuming, and closing calls have human-readable activity descriptions.

### Fixed

- Child rollout additions, changes, and removals refresh their root run. Remaining descendants stay discoverable when a parent rollout disappears.
- When a selected orphan later acquires its parent, the open view follows the new root and preserves the selected agent.
- A detail read interrupted by a public rescan retries once against the current tree, so selecting a run during discovery does not lose its available detail.
- Tree summaries count each native thread once and prefer running, errored, idle, then finished status across the tree. Completed child turns finish immediately, and resumed turns become active again.
- Incomplete metadata lines do not create temporary path-based sessions. Corrupt parent cycles are broken deterministically, and ancestor resolution handles deep trees iteratively.
- Small Claude session files use their head chunk to derive API errors, the latest activity, and pending tool state when there is no separate tail chunk.

### Changed

- Codex tool-result errors now require an explicit failure flag (`isError` or `is_error`), a numeric exit code (including `metadata.exit_code`), or a process exit-status line. Merely containing the word `error` no longer marks a result as failed. This deliberately means an unstructured non-shell result such as `Error: ENOENT: no such file or directory` remains visible in the result preview without an inferred error badge; producers must provide explicit failure metadata for reliable classification.
