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
npm i -D github:sdcomms4227/duetcode#v0.2.2
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

To stop a running dispatch, write `{"runId":"<current-run-id>"}` to `.duet/state/abort`. The current ID is the directory name under `.duet/state/runs/` (and is also recorded in that run's `metadata.json`). The dispatcher polls this file, terminates the Codex process tree only when the ID matches, consumes the matching request, and leaves the task in `IMPLEMENTING`. Missing, malformed, and stale requests do not stop a run. An accepted abort exits as `INCOMPLETE` (5) and is recorded as `outcome.kind: "aborted"`.

Dispatch's own exit code says *why* a run did not complete — this is distinct from Codex's exit code:

| Code | Name | Meaning |
|---|---|---|
| 0 | `SUCCESS` | REVIEW reached, `task lint` passed, git state measured |
| 1 | `INTERNAL` | Dispatcher-side failure: artifact/log write, TASK snapshot, or a post-run measurement that could not be trusted |
| 2 | `GUARD` | Refused before Codex was called: not `READY`, lock held, missing `--high-risk-approved`, bad flag, unconfirmed transition |
| 3 | `TIMEOUT` | Killed at the cap. Never interpreted as success |
| 4 | `TRANSPORT` | Codex could not be started or fed, or the stream reported a transport failure |
| 5 | `INCOMPLETE` | Codex ran but the result is not a success: operator abort, abnormal exit, model-reported failure, REVIEW not reached, `task lint` failed, git state unmeasurable, the Active Task changed mid-run, or no `thread_id` was captured |

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
- For handoff **on Windows**: Codex runs the delegated work in a sandbox (`sandbox_mode="workspace-write"`), which requires its sandbox helper to launch. A broken or missing helper does not fail Codex itself — Codex can exit 0 with a normal event stream — but the dispatcher classifies the run as `TRANSPORT` (exit 4) because the environment the work ran in cannot be vouched for. There is no preflight for this: it is only detectable once the stream reports it. Install Codex through its official Windows installer rather than copying the binary, so the helper lands beside it.

> On exit 4, read `measurement` in the run's `result.json` **before re-running.** A transport failure does not mean nothing happened — the dispatcher records whether the Active Task already reached `REVIEW` and whether the working tree changed, and repeats those facts in the failure reason. Re-running blindly can duplicate finished work.

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `TASK_STATE_FILE` | see note | Override the state-file path. A relative value is resolved against the repo root by `duet-handoff`, but against the current directory by `duet-task` |
| `HANDOFF_STATE_DIR` | `.duet/state/` | Handoff runtime state (git-ignored) |
| `DUET_REPO_ROOT` | `git rev-parse` | Override the repo root. Both binaries read it — `duet-handoff` anchors `TASK.md` and `.duet/state/` to it, `duet-task` falls back to it when the current directory has no `TASK.md` |
| `HANDOFF_CODEX_CMD` | `codex` [^1] | Codex executable / args (JSON array allowed) |
| `HANDOFF_RUN_RETENTION` | `20` | How many run directories under `<state>/runs/` to keep. Older ones are deleted when a new run starts |

> **Where `duet-task` looks for `TASK.md`**, when `TASK_STATE_FILE` is unset: the current directory first, then the repo root. So running it from the repo root behaves as it always has, and running it from a subdirectory finds the repo's `TASK.md` instead of failing. `duet-handoff` always resolves against the repo root.

[^1]: On Windows, when this variable is unset, the installed launcher at `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin\codex.exe` is preferred if it exists; otherwise `codex` is resolved from `PATH`.

## Design notes

- **Single source of truth.** `TASK.md`'s YAML front matter is the machine-readable state; the prose below is the human detail. Only one Active Task at a time.
- **Trust model.** The enforcement (write-restricted `task set`, TTY checks, lint) is a guardrail for cooperative-but-fallible agents, not a security boundary. The last line of defense is a human reviewing `git diff TASK.md` before commit.
- **Human gates.** Commit/push/release, high-risk work, public API / schema / security changes, secrets, and external writes (issue-sync) are never automated. The pipeline stops at `REVIEW`.
- **Run artifacts are redacted, streamed, and pruned.** Each dispatch writes its prompt, event stream, and result under `<state>/runs/<run-id>/`. Logs are masked as they are written, but only up to a point the redactor can prove is safe to cut — it emits on line boundaries, keeps a tail margin wider than the longest secret in the environment, and holds an unterminated PEM block until it closes. Old run directories are deleted once there are more than `HANDOFF_RUN_RETENTION` of them; the count removed is recorded in the new run's `metadata.json`.
- **`task verify` — the automated, non-destructive HTTP smoke harness.** It is the third and last path that writes `verification` (after `record-verification` and `approve-partial`), and the only one where the CLI decides the status itself, so its scope is deliberately narrow. It reads `.duet/verify.json` (git-ignored, never committed) and refuses to run when the profile is not whitelisted — a profile whose *name* reads as production (`prod`, `production`, `live`, `release`, `main`, …) is rejected even if you add it to `allowedProfiles`, because verifying production is a human gate. Only `GET`/`HEAD` with no request body is allowed and redirects are not followed, so a check can never write or wander off the configured origin; the base URL must be loopback unless `allowRemoteHost` is set. Missing configuration (an absent credential env var, an unfilled record id) skips just that check and yields `PARTIAL` — "not configured" must not read as "broken". Exceeding `maxDurationMs` fails the remaining checks rather than skipping them. If `server` is configured the harness starts it and stops **only the process it started**, on every exit path. It records evidence whose `exitCode` matches its own verdict, so lint's "PASSED with a non-zero exit code" rule applies to it too.

  ```bash
  npm run task -- verify     # REVIEW only; exits 1 on FAILED/PARTIAL, and records the result either way
  ```
