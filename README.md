# duetcode

> A **duet**, not a swarm: Claude designs and reviews, Codex implements, and a human holds the gate between them.

A Claude Code plugin that drops a reusable **state-machine + human-gate pipeline** into any repository. It revolves around a single state file — `TASK.md` — and passes the implementation *baton* back and forth between two agents (**Claude ↔ Codex**) under strict, machine-enforced rules. The agents run one at a time in a serial relay, never concurrently.

> ⚠️ **This installer writes into the repository you point it at.** A default run creates `tools/`, `TASK.md`, `docs/`, and a CI workflow; additively merges scripts and a devDependency into an existing `package.json`; and adds any missing entries to `.gitignore`. `--force` **overwrites** the engine directories, discarding any local edits made to `tools/`. Run it against a clean working tree so `git diff` shows you exactly what changed.

The engine is repo-native (pure Node.js + `yaml`): it installs into the target repo's `tools/` and runs directly against that repo's git and CI. The AI is only an adapter.

## What it installs

| Target | Contents |
|---|---|
| `tools/task/` | State-machine CLI (transition enforcement, lint, verification recording) + tests |
| `tools/handoff/` | Codex handoff dispatcher (atomic lock, timeout, measured outcome) + tests |
| `TASK.md` | Active Task state (single source of truth: front matter + prose) |
| `.github/workflows/task-lint.yml` | CI: `task:lint` + `task:test` (+ `handoff:test` unless `--no-handoff`) |
| `docs/duetcode-*.md` | Collaboration protocol, design, workflow example |
| `package.json` | `task*` / `handoff*` scripts, `yaml` devDependency (merged into an existing file) |
| `.gitignore` | Missing entries appended (`node_modules/`, handoff runtime state, local verify config) |

## Install

### Via the Claude Code marketplace

This repo is its own single-plugin marketplace:

```
/plugin marketplace add sdcomms4227/duetcode
/plugin install duetcode@duetcode
```

Installing the plugin gives you the `/duetcode:task` and `/duetcode:handoff` commands and the `duetcode:pipeline-install` / `duetcode:pipeline` skills. To scaffold the engine into a repo, invoke the `duetcode:pipeline-install` skill (or run the installer manually below).

### Manual (from a clone)

```bash
git clone https://github.com/sdcomms4227/duetcode
node duetcode/scripts/install.js --target /path/to/your-repo
cd /path/to/your-repo
npm install
node tools/task/index.js lint
```

Options: `--no-handoff` (core only — installs no Codex handoff, and does **not** remove one already installed), `--force` (refresh the engine), `--engine-only --force` (sync only `tools/`, leaving docs / `package.json` / `TASK.md` / CI untouched — for updating an existing install from the canonical source; it reports outdated scripts instead of rewriting them). Idempotent by default: an existing `TASK.md` is left alone entirely, and `package.json` / `.gitignore` keep everything already in them. One narrow exception: a `task*` / `handoff*` script whose value exactly matches a known previous release's is migrated to the current one, so upgrades do not leave dead commands behind. Any other value — including anything you edited — is reported as a conflict and left untouched.

Optional: to auto-lint on session end, merge `templates/stop-hook-snippet.json` into the target repo's `.claude/settings.json`.

## Usage

```bash
node tools/task/index.js start <id> --objective <goal> --requester <who> --designer <who>
# then edit TASK.md: fill in the four prose sections that `start` stubbed out.
# Placeholders (없음 / 미정 / TODO / -) are rejected, so READY fails until they are real.
node tools/task/index.js set roles.implementer=<who> roles.reviewer=<who> designCheckpoint=<sha>
node tools/task/index.js set status=READY
npm run handoff                     # delegate implementation to Codex -> REVIEW
node tools/task/index.js record-verification --status PASSED --failed-count 0
node tools/task/index.js set status=DONE
```

State machine: `IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE`, plus two loopbacks out of `REVIEW` — `→ IMPLEMENTING` (fix the implementation) and `→ READY` (change the design; requires `--design-checkpoint`). Both reset `verification`, so a stale `PASSED` can never carry a task to `DONE`. `BLOCKED`, `CANCELLED`, and `SUPERSEDED` are reached through their own commands (`block`/`unblock`, `cancel`, `supersede`), not through `set status=`.

Human gates and verification rules: see the `duetcode:pipeline` skill / [docs/pipeline-design.md](docs/pipeline-design.md) / [docs/pipeline-workflow-example.md](docs/pipeline-workflow-example.md).

Proposal (not yet implemented) to make the engine location-independent so target repos can gitignore `tools/`: [docs/engine-externalization.md](docs/engine-externalization.md). Security review for the public release: [docs/public-release-readiness.md](docs/public-release-readiness.md). Naming rationale, remaining release steps, and migration notes for repos installed from the previous name: [docs/release-checklist.md](docs/release-checklist.md).

## Handoff

`npm run handoff` delegates a `READY` task to Codex and stops at `REVIEW`. It never commits, retries, or advances to `DONE`.

| Flag | Purpose |
|---|---|
| `--resume` | Continue a recorded Codex thread — a REVIEW follow-up round, or recovery from an `IMPLEMENTING` crash |
| `--high-risk-approved` | Acknowledge the `highRisk` human/Opus gate; without it a high-risk task is refused |
| `--timeout-min N` | Cap the whole Codex run (default 30) |

Dispatch's own exit code says *why* a run did not complete — this is distinct from Codex's exit code:

| Code | Name | Meaning |
|---|---|---|
| 0 | `SUCCESS` | REVIEW reached, `task lint` passed, git state measured |
| 1 | `INTERNAL` | Dispatcher-side failure: artifact/log write, TASK snapshot, or a post-run measurement that could not be trusted |
| 2 | `GUARD` | Refused before Codex was called: not `READY`, lock held, missing `--high-risk-approved`, bad flag, unconfirmed transition |
| 3 | `TIMEOUT` | Killed at the cap. Never interpreted as success |
| 4 | `TRANSPORT` | Codex could not be started or fed, or the stream reported a transport failure |
| 5 | `INCOMPLETE` | Codex ran but the result is not a success: abnormal exit, model-reported failure, REVIEW not reached, `task lint` failed, git state unmeasurable, the Active Task changed mid-run, or no `thread_id` was captured |

**Exit 0 alone is not proof of success.** Before reporting success the dispatcher measures the front-matter status, `task lint`, and `git status` — a run that exits 0 without reaching `REVIEW` is reported as `INCOMPLETE`.

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

Semver, with the public surface defined as: the **`TASK.md` front-matter schema**, the **state-transition table**, and the **`task` / `handoff` CLI surface** (command names, flags, exit codes). A change that would make an existing `TASK.md` fail `lint`, remove a transition, or change a documented flag or exit code is **breaking**. Everything else — prose templates, generated doc filenames, internal module layout — is not covered. Renaming a generated doc is not a semver break, but it is not free either: the installer is skip-if-exists, so on the next install the old file stays and the new one lands beside it. Renames therefore ship with migration notes in [docs/release-checklist.md](docs/release-checklist.md).

Pre-`1.0.0`, breaking changes land in minor releases. Pin an exact tag if you need stability.

## Requirements

- Node.js ≥ 18 (the engine has no runtime dependency beyond `yaml`). The npm test scripts deliberately avoid shell globbing, so they behave the same under Windows `cmd.exe` and POSIX shells.
- For handoff: the `codex` CLI (override the executable via `HANDOFF_CODEX_CMD`). Without it, the core (state machine, lint, CI) still works fully.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TASK_STATE_FILE` | `TASK.md` | Override the state-file path |
| `HANDOFF_STATE_DIR` | `tools/handoff/state/` | Handoff runtime state (git-ignored) |
| `HANDOFF_CODEX_CMD` | `codex` [^1] | Codex executable / args (JSON array allowed) |

[^1]: On Windows, when this variable is unset, the installed launcher at `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` is preferred if it exists; otherwise `codex` is resolved from `PATH`.

## Design notes

- **Single source of truth.** `TASK.md`'s YAML front matter is the machine-readable state; the prose below is the human detail. Only one Active Task at a time.
- **Trust model.** The enforcement (write-restricted `task set`, TTY checks, lint) is a guardrail for cooperative-but-fallible agents, not a security boundary. The last line of defense is a human reviewing `git diff TASK.md` before commit.
- **Human gates.** Commit/push/release, high-risk work, public API / schema / security changes, secrets, and external writes (issue-sync) are never automated. The pipeline stops at `REVIEW`.
- `task verify` (the automated HTTP smoke harness, Tier 2) is not implemented yet.
