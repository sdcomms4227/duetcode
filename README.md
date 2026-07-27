# duetcode

> A **duet**, not a swarm: Claude designs and reviews, Codex implements, and a human holds the gate between them.

A Claude Code plugin that drops a reusable **state-machine + human-gate pipeline** into any repository. It revolves around a single state file — `TASK.md` — and passes the implementation *baton* back and forth between two agents (**Claude ↔ Codex**) under strict, machine-enforced rules. The agents run one at a time in a serial relay, never concurrently.

> ⚠️ **This installer writes into the repository you point it at.** A default run creates `tools/`, `TASK.md`, `docs/`, and a CI workflow, and additively merges scripts and a devDependency into an existing `package.json`. `--force` **overwrites** the engine directories, discarding any local edits made to `tools/`. Run it against a clean working tree so `git diff` shows you exactly what changed.

The engine is repo-native (pure Node.js + `yaml`): it installs into the target repo's `tools/` and runs directly against that repo's git and CI. The AI is only an adapter.

## What it installs

| Target | Contents |
|---|---|
| `tools/task/` | State-machine CLI (transition enforcement, lint, verification recording) + tests |
| `tools/handoff/` | Codex handoff dispatcher (atomic lock, timeout, measured outcome) + tests |
| `TASK.md` | Active Task state (single source of truth: front matter + prose) |
| `.github/workflows/task-lint.yml` | CI: `task:lint` + `task:test` (+ `handoff:test` unless `--no-handoff`) |
| `docs/duetcode-*.md` | Collaboration protocol, design, workflow example |
| `package.json` | `task*` / `handoff*` scripts, `yaml` devDependency |

## Install

### Via the Claude Code marketplace

This repo is its own single-plugin marketplace:

```
/plugin marketplace add sdcomms4227/duetcode
/plugin install duetcode@duetcode
```

Installing the plugin gives you the `/duetcode:task` and `/duetcode:handoff` commands and the `pipeline-install` / `pipeline` skills. To scaffold the engine into a repo, invoke the `pipeline-install` skill (or run the installer manually below).

### Manual (from a clone)

```bash
git clone https://github.com/sdcomms4227/duetcode
node duetcode/scripts/install.js --target /path/to/your-repo
cd /path/to/your-repo
npm install
node tools/task/index.js lint
```

Options: `--no-handoff` (core only, no Codex handoff), `--force` (refresh the engine), `--engine-only --force` (sync only `tools/`, leaving docs / `package.json` / `TASK.md` / CI untouched — for updating an existing install from the canonical source). Idempotent by default — existing `TASK.md`, `package.json`, and `.gitignore` contents are preserved.

Optional: to auto-lint on session end, merge `templates/stop-hook-snippet.json` into the target repo's `.claude/settings.json`.

## Usage

```bash
node tools/task/index.js start <id> --objective <goal> --requester <who> --designer <who>
# design (fill in the prose sections) -> set roles & checkpoint
node tools/task/index.js set status=READY
npm run handoff                     # delegate implementation to Codex -> REVIEW
node tools/task/index.js record-verification --status PASSED --failed-count 0
node tools/task/index.js set status=DONE
```

State machine `IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE`, human gates, and verification rules: see the `pipeline` skill / [docs/pipeline-design.md](docs/pipeline-design.md) / [docs/pipeline-workflow-example.md](docs/pipeline-workflow-example.md).

Proposal (not yet implemented) to make the engine location-independent so target repos can gitignore `tools/`: [docs/engine-externalization.md](docs/engine-externalization.md). Security review for taking this repo public: [docs/public-release-readiness.md](docs/public-release-readiness.md).

## Layout

```text
.claude-plugin/plugin.json
.claude-plugin/marketplace.json   # single-plugin marketplace descriptor
skills/pipeline-install/          # bootstrap installer skill
skills/pipeline/                  # operating-manual skill
commands/{task,handoff}.md        # /duetcode:task, /duetcode:handoff
engine/{task,handoff}/            # engine source, copied verbatim into the target's tools/
templates/                        # TASK.template, protocol, CI, gitignore, package, stop-hook
scripts/install.js                # deterministic, idempotent installer
docs/                             # design & workflow reference
```

## Versioning

Semver, with the public surface defined as: the **`TASK.md` front-matter schema**, the **state-transition table**, and the **`task` / `handoff` CLI surface** (command names, flags, exit codes). A change that would make an existing `TASK.md` fail `lint`, remove a transition, or change a documented flag or exit code is **breaking**. Everything else — prose templates, generated doc filenames, internal module layout — is not covered.

Pre-`1.0.0`, breaking changes land in minor releases. Pin an exact tag if you need stability.

## Requirements

- Node.js ≥ 18 (the engine has no runtime dependency beyond `yaml`)
- For handoff: the `codex` CLI (override the executable via `HANDOFF_CODEX_CMD`). Without it, the core (state machine, lint, CI) still works fully.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TASK_STATE_FILE` | `TASK.md` | Override the state-file path |
| `HANDOFF_STATE_DIR` | `tools/handoff/state/` | Handoff runtime state (git-ignored) |
| `HANDOFF_CODEX_CMD` | `codex` | Codex executable / args (JSON array allowed) |

## Design notes

- **Single source of truth.** `TASK.md`'s YAML front matter is the machine-readable state; the prose below is the human detail. Only one Active Task at a time.
- **Trust model.** The enforcement (write-restricted `task set`, TTY checks, lint) is a guardrail for cooperative-but-fallible agents, not a security boundary. The last line of defense is a human reviewing `git diff TASK.md` before commit.
- **Human gates.** Commit/push/release, high-risk work, public API / schema / security changes, secrets, and external writes (issue-sync) are never automated. The pipeline stops at `REVIEW`.
- `task verify` (the automated HTTP smoke harness, Tier 2) is not implemented yet.
