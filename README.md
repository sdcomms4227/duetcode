# duetcode

> A **duet**, not a swarm: Claude designs and reviews, Codex implements, and a human holds the gate between them.

A Claude Code plugin that drops a reusable **state-machine + human-gate pipeline** into any repository. It revolves around a single state file — `TASK.md` — and passes the implementation *baton* back and forth between two agents (**Claude ↔ Codex**) under strict, machine-enforced rules. The agents run one at a time in a serial relay, never concurrently.

> ℹ️ **This is an internal tool, published so our own repositories can install it as a dependency.** It is offered as-is under MIT — there is no support commitment, roadmap, or expectation of external contributions.

> ⚠️ **The bootstrap writes into the repository you point it at.** A run creates `TASK.md`, `docs/`, and a CI workflow; additively merges scripts and a devDependency into an existing `package.json`; and adds any missing entries to `.gitignore`. It never touches the engine — that arrives through `node_modules`. Run it against a clean working tree so `git diff` shows you exactly what changed.

The engine is repo-native (pure Node.js + `yaml`): it installs as a devDependency and runs directly against the target repo's git and CI. The AI is only an adapter.

## What it sets up

| Target | Contents |
|---|---|
| `package.json` | `duetcode` devDependency + `task` / `task:lint` / `handoff` scripts (merged into an existing file) |
| `TASK.md` | Active Task state (single source of truth: front matter + prose) |
| `.github/workflows/task-lint.yml` | CI: `npm run task:lint` |
| `docs/duetcode-*.md` | Collaboration protocol, design, workflow example |
| `.gitignore` | Missing entries appended (`node_modules/`, `.duet/`) |

The engine itself is **not** copied into the repo. It lives in `node_modules/duetcode` and is invoked through the `duet-task` / `duet-handoff` binaries, so upgrading is `npm install` and the version you use is pinned in your lockfile.

## Install

### Via the Claude Code marketplace

This repo is its own single-plugin marketplace:

```
/plugin marketplace add sdcomms4227/duetcode
/plugin install duetcode@duetcode
```

Installing the plugin gives you the `/duetcode:task` and `/duetcode:handoff` commands and the `duetcode:pipeline-install` / `duetcode:pipeline` skills. To scaffold the engine into a repo, invoke the `duetcode:pipeline-install` skill (or run the installer manually below).

### As a dependency

```bash
cd /path/to/your-repo
npm i -D github:sdcomms4227/duetcode#v0.1.3
npx duet-init          # bootstraps TASK.md, docs, CI, .gitignore entries
npm install
npm run task:lint
```

`duet-init` options: `--target <path>` and `--no-handoff` (omits the `handoff` script; it does **not** remove one already set up). Idempotent: an existing `TASK.md` is left alone entirely, and `package.json` / `.gitignore` keep everything already in them. One narrow exception — a script whose value exactly matches a known previous release's (e.g. `node tools/task/index.js`) is migrated to the current one, so upgrades do not leave dead commands behind. Any other value, including anything you edited, is reported as a conflict and left untouched.

**Upgrading:** bump the tag in `package.json` and `npm install`. Nothing else to sync.

**Coming from a pre-duetcode install** (the old `cc-symphony` layout, which copied the engine into `tools/`): re-run `npx duet-init`, then delete the leftovers it reports — the stale `tools/` directory and the now-pointless `task:test` / `handoff:test` scripts. Move anything under `tools/handoff/state/` to `.duet/state/` first if a handoff is mid-flight.

Optional: to auto-lint on session end, merge `templates/stop-hook-snippet.json` into the target repo's `.claude/settings.json`.

## Usage

```bash
npm run task -- start <id> --objective <goal> --requester <who> --designer <who>
# then edit TASK.md: fill in the four prose sections that `start` stubbed out.
# Placeholders (없음 / 미정 / TODO / -) are rejected, so READY fails until they are real.
npm run task -- set roles.implementer=<who> roles.reviewer=<who> designCheckpoint=<sha>
npm run task -- set status=READY
npm run handoff                     # delegate implementation to Codex -> REVIEW
npm run task -- record-verification --status PASSED --failed-count 0 \
  --evidence "npm test"           # runs it, records exit code + output hash
npm run task -- set status=DONE
```

`duet-task` is on `PATH` inside npm scripts, so `npx duet-task <command>` works too.

State machine: `IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE`, plus two loopbacks out of `REVIEW` — `→ IMPLEMENTING` (fix the implementation) and `→ READY` (change the design; requires `--design-checkpoint`). Both reset `verification`, so a stale `PASSED` can never carry a task to `DONE`. `BLOCKED`, `CANCELLED`, and `SUPERSEDED` are reached through their own commands (`block`/`unblock`, `cancel`, `supersede`), not through `set status=`.

Human gates and verification rules: see the `duetcode:pipeline` skill / [docs/pipeline-design.md](docs/pipeline-design.md) / [docs/pipeline-workflow-example.md](docs/pipeline-workflow-example.md).

How the engine became location-independent and why it ships as a dependency: [docs/engine-externalization.md](docs/engine-externalization.md). Security review for the public release: [docs/public-release-readiness.md](docs/public-release-readiness.md). Naming rationale, release record, and migration notes for repos installed from the previous name: [docs/release-checklist.md](docs/release-checklist.md).

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
engine/{task,handoff}/            # engine source — shipped in the package, run from node_modules
templates/                        # TASK.template, protocol, CI, gitignore, package, verify, stop-hook
scripts/install.js                # duet-init: bootstraps target-owned files only
package.json                      # bin: duet-task / duet-handoff / duet-init
docs/                             # design & workflow reference
```

## Versioning

Semver, with the public surface defined as: the **`TASK.md` front-matter schema**, the **state-transition table**, and the **`task` / `handoff` CLI surface** (command names, flags, exit codes). The binary names (`duet-task`, `duet-handoff`, `duet-init`) are part of that surface too. A change that would make an existing `TASK.md` fail `lint`, remove a transition, or change a documented flag, binary name, or exit code is **breaking**. Everything else — prose templates, generated doc filenames, internal module layout — is not covered. Renaming a generated doc is not a semver break, but it is not free either: the bootstrap is skip-if-exists, so on the next run the old file stays and the new one lands beside it. Renames therefore ship with migration notes in [docs/release-checklist.md](docs/release-checklist.md).

Pre-`1.0.0`, breaking changes land in minor releases. Pin an exact tag if you need stability.

## Requirements

- Node.js ≥ 18 (the engine has no runtime dependency beyond `yaml`). The npm test scripts deliberately avoid shell globbing, so they behave the same under Windows `cmd.exe` and POSIX shells.
- For handoff: the `codex` CLI (override the executable via `HANDOFF_CODEX_CMD`). Without it, the core (state machine, lint, CI) still works fully.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TASK_STATE_FILE` | `TASK.md` | Override the state-file path. A relative value is resolved against the repo root by `duet-handoff`, but against the current directory by `duet-task` |
| `HANDOFF_STATE_DIR` | `.duet/state/` | Handoff runtime state (git-ignored) |
| `DUET_REPO_ROOT` | `git rev-parse` | Override the repo root — **`duet-handoff` only**; `duet-task` does not read it and always works from the current directory |
| `HANDOFF_CODEX_CMD` | `codex` [^1] | Codex executable / args (JSON array allowed) |

[^1]: On Windows, when this variable is unset, the installed launcher at `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` is preferred if it exists; otherwise `codex` is resolved from `PATH`.

## Design notes

- **Single source of truth.** `TASK.md`'s YAML front matter is the machine-readable state; the prose below is the human detail. Only one Active Task at a time.
- **Trust model.** The enforcement (write-restricted `task set`, TTY checks, lint) is a guardrail for cooperative-but-fallible agents, not a security boundary. The last line of defense is a human reviewing `git diff TASK.md` before commit.
- **Human gates.** Commit/push/release, high-risk work, public API / schema / security changes, secrets, and external writes (issue-sync) are never automated. The pipeline stops at `REVIEW`.
- `task verify` (the automated HTTP smoke harness, Tier 2) is not implemented yet.
