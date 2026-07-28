# CLAUDE.md

This file is the single source of repository instructions for coding agents working here — Claude Code and Codex alike. `AGENTS.md` points at this file so both read the same rules; keep it that way and update this file rather than forking guidance.

## What this repo is

duetcode is an **npm package and a Claude Code plugin**, not an app. It ships a state-machine + human-gate pipeline (`engine/`) that target repos install as a devDependency and invoke through the `duet-task` / `duet-handoff` binaries. `scripts/install.js` (`duet-init`) no longer copies the engine — it only bootstraps what the *target* repo owns: `TASK.md`, protocol docs, CI, and `.gitignore` entries.

Neither engine infers anything from its own path, so both behave identically under `node_modules/`, a checkout, or anywhere else — but they anchor differently, and the difference is load-bearing. `engine/handoff/lib.js` resolves a repo root explicitly (`DUET_REPO_ROOT` → `git rev-parse --show-toplevel` → cwd) and resolves `TASK.md` and `.duet/state/` against it. The task CLI has no repo-root concept at all: `engine/task/index.js` loads `process.env.TASK_STATE_FILE || 'TASK.md'` **relative to cwd** and ignores `DUET_REPO_ROOT`. So `duet-task` run from a subdirectory does not find the repo's `TASK.md`, while `duet-handoff` does. Anything documenting `DUET_REPO_ROOT` must say handoff, not "the engine".

Two engines live under `engine/`, installed as separate directories but **not** mutually independent:
- `engine/task/` — the `TASK.md` state-machine CLI (`index.js` + `lib.js`). Standalone; `--no-handoff` installs this alone.
- `engine/handoff/` — the Codex handoff dispatcher (`dispatch.js`, `lib.js`, `build-prompt.js`, `parse-result.js`). Depends on task in both directions of the call: it imports `../task/lib` (`build-prompt.js:4`) and spawns the task CLI resolved via `require.resolve('../task/index.js')` (`lib.js`). There is no handoff-only install.

## Commands

Everything runs from this repo root against `engine/` directly — no self-install, no scratch directory:

```bash
npm install         # yaml
npm test            # task + handoff + installer suites
npm run task:test   # node engine/task/test/run.js
npm run handoff:test
npm run install:test
npm run task:lint   # validates this repo's TASK.md, if one exists
npm run version:sync   # align version references with package.json
npm run version:check  # same, read-only: exits 1 on drift
```

`package.json`'s `version` is the source for the install specs in `README.md`, `skills/pipeline-install/SKILL.md`, and `templates/package-json-snippet.json`, and for `.claude-plugin/plugin.json`. `scripts/sync-version.js` keeps them aligned; `scripts/test/version-sync.test.js` catches drift. Historical versions in release records are intentionally excluded. Bump with `npm version <newversion> --no-git-tag-version` — the `version` lifecycle syncs the references but must not commit or tag, because committing and tagging a release is a human gate.

Test scripts name files explicitly instead of globbing — `test/run.js` enumerates `*.test.js` itself. Both shorthands behave differently across shells and Node versions (measured): a glob is expanded by POSIX shells but not by `cmd.exe`, which is what Windows' npm uses, so the literal pattern reaches Node — and Node only expands globs from v21, leaving v18/20 to fail with `Could not find`. A directory argument diverges the other way: v18/20 recurse into it, v22 tries to load the path as a module and dies with `MODULE_NOT_FOUND`. Enumerating files removes every one of those branches.

To exercise the *bootstrap* path, point it at a scratch directory outside this repo. Until the package is published, wire the dependency with a `file:` spec to test the real resolution path:

```bash
node scripts/install.js --target <scratch-dir>
cd <scratch-dir>
npm pkg set devDependencies.duetcode=file:/path/to/duetcode
npm install && npm run task:lint
```

Bootstrap flags: `--no-handoff` omits the `handoff` script (it does **not** uninstall an existing one); `--target <path>` chooses the target. There is no `--force` or `--engine-only` any more — those existed to manage copied engine directories, and nothing is copied now.

In a target repo the state machine is driven via `duet-task <command>`, aliased to `npm run task`; see "State machine" below.

## Architecture

### Single source of truth: `TASK.md`

The entire pipeline pivots on one file, `TASK.md`, in the *target* repo: YAML front matter is the machine-readable state, prose below it is human detail. Only one Active Task exists at a time. `engine/task/lib.js` parses it with a strict `---\n...\n---` front-matter regex (`parseSource`) and rewrites it losslessly via `yaml`'s `parseDocument`/`toString` (preserves comments/formatting). `save()` writes to a temp file and renames — a half-written `TASK.md` would block `lint`, `show`, and every handoff at once.

### State machine (`engine/task/lib.js` + `index.js`)

States: `IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE`, plus two loopbacks out of `REVIEW` — `→ IMPLEMENTING` (fix the implementation) and `→ READY` (change the design; requires `--design-checkpoint`). Both reset `verification`, so a stale `PASSED` can never carry a task to `DONE`. `BLOCKED` is reachable from any `ACTIVE` state; `CANCELLED`/`SUPERSEDED` are terminal off-ramps.

`TRANSITIONS` in `lib.js` is the adjacency map for `set status=X` only — that path calls `transition()`, which enforces it. The remaining edges bypass it: `block`/`unblock`, `cancel`/`supersede`, and `reset` each apply their own guard in `index.js` and then set `status` directly. Changing the state graph means touching both places.

`validate()` in `lib.js` is where most of the domain logic actually lives, not `index.js`:
- Required fields escalate by state (e.g. `roles.implementer`/`roles.reviewer`/`designCheckpoint` only required from `READY` onward).
- `highRisk: true` requires the literal substring `Opus` in `roles.designer` (and in `roles.reviewer` from `READY` onward). Note what is actually enforced: a string in a field, plus the presence of `--high-risk-approved` at dispatch. Neither proves a human approved or that any particular model ran — it is a speed bump that makes bypassing the gate a deliberate act, not evidence the gate was honored.
- Reaching `READY`+ requires specific `### ` sections in the prose body to be non-placeholder (`meaningful()` rejects `없음`/`미정`/`TODO`/`-`). `REVIEW`+ additionally requires the `다음 담당자` / `다음 행동` bullets under `### Review와 다음 행동` to carry real values (`labelled()`).
- `DONE` requires `verification.status === 'PASSED'` (or `PARTIAL` with `partialApproved === true`) and `failedCount === 0` (`canDone()`).
- `verification.evidence` is optional (older `TASK.md` files predate it), but when present it must be well-formed **and consistent**: a `PASSED` status with a non-zero `evidence.exitCode` is rejected. `record-verification --evidence "<cmd>"` runs the command and records `{command, exitCode, outputSha256, at}` — recording the string alone would just be self-reporting.
- `reset` from a terminal state requires the TASK.md file itself to be committed clean (`requireCleanShare`). `CANCELLED`/`SUPERSEDED` may skip that when `closure.archiveRef` is set; `DONE` never may, because `archive` refuses any state but those two (`verifyArchiveRef`). This is what stops silent loss of a closed task's record.

`start` replaces the prose body with `STARTER_BODY`, a placeholder skeleton — this is deliberate, so a new task can never inherit a stale previous task's write-up (see the code comment in `lib.js` referencing the past defect this fixed).

`approve-partial` is the one interactive command: it requires both stdin and stdout to be a real TTY and reads a typed `APPROVE` confirmation — this is intentionally not scriptable.

### Handoff dispatcher (`engine/handoff/`)

`dispatch.js` delegates `IMPLEMENTING`-state work to the `codex` CLI as a subprocess, then parses its result back into `TASK.md`. Key mechanics in `lib.js`:
- `EXIT_CODES`: `SUCCESS` 0, `INTERNAL` 1, `GUARD` 2, `TIMEOUT` 3, `TRANSPORT` 4, `INCOMPLETE` 5 — dispatch's own exit code communicates *why* a run didn't complete, distinct from Codex's exit code. These values are part of the public surface (README "Versioning"); changing one is a breaking change.
- `acquireLock`/`releaseLock` under `HANDOFF_STATE_DIR` (default `<repo-root>/.duet/state/`, git-ignored) make concurrent dispatch invocations mutually exclusive. The state lives outside the engine on purpose — the engine is a dependency that gets reinstalled, and state must survive that.
- `--resume` reuses a recorded `thread_id` from session state — for continuing a REVIEW round or recovering from an IMPLEMENTING crash without losing Codex conversation context.
- `--high-risk-approved` is the CLI-side acknowledgment of the `highRisk` gate before a risky task is allowed to dispatch; `--timeout-min N` caps the whole Codex run (default 30, `DEFAULT_TIMEOUT_MINUTES`).
- `redactText` / `sanitizeFile` exist because Codex output and prompts get logged to `HANDOFF_STATE_DIR` — secrets must not leak into that state.

`build-prompt.js` assembles what Codex actually receives from `TASK.md`'s current state; `parse-result.js` (`ResultParser`) interprets Codex's structured response back into a status/outcome dispatch.js can act on.

### Installer (`scripts/install.js`)

Bootstrap only — it creates what the target repo *owns* and never the engine. Deterministic and idempotent, but "idempotent" is not "read-only": `ensureFileFromTemplate` is skip-if-exists, while `mergePackageJson` rewrites the target's `package.json` and `appendGitignore` merges into its `.gitignore` **entry by entry** (a snippet that is only partly present still gets its missing lines — an all-or-nothing check would mean new entries never reach existing installs). Both only ever add.

Upgrading an existing install is the harder half, and the rules are deliberate:
- A script is replaced only when its current value matches a known previous value in `LEGACY_SCRIPTS` (e.g. `node tools/task/index.js` → `duet-task`). Anything else might be the user's own edit, so it is reported as a conflict and left untouched.
- Leftovers from the copied-engine era — `task:test` / `handoff:test` scripts, a stale `tools/` directory — are **reported, never deleted**. Removing a user's files is not the installer's call.
- `--no-handoff` skips the `handoff` script but does **not** remove an existing handoff setup. It means "don't add", not "uninstall".

The installer intentionally uses **only Node built-ins** (no `yaml` import) because it runs before the target's `npm install` has fetched anything.

### Plugin surface

`commands/{task,handoff}.md` define the `/duetcode:task` and `/duetcode:handoff` slash commands; `skills/pipeline-install/` and `skills/pipeline/` are the bootstrap-installer and operating-manual skills respectively, invoked as `duetcode:pipeline-install` / `duetcode:pipeline` once the plugin is installed via the marketplace.

## Contributor guidelines

### Project structure

`engine/task/` and `engine/handoff/` are the runtime sources and the only copy that exists — target repos consume them from `node_modules`, so there is no generated duplicate to keep in sync any more. Bootstrap logic and its tests live in `scripts/install.js` and `scripts/test/`. Plugin commands are in `commands/`, reusable workflow instructions in `skills/`, generated-file sources in `templates/`, and design references in `docs/`. Update the canonical engine or template rather than a temporary installation artifact.

Three docs are worth reading before specific kinds of change: `docs/pipeline-design.md` is the precise spec for the state machine, verification, and gates — consult it before altering any rule, and keep it in sync when you do. `docs/engine-externalization.md` is the implemented design behind the engine's location independence and its shipping as a dependency — it records why `REPO_ROOT` and `TASK_CLI` resolve the way they do, so read it before touching those path assumptions. `docs/release-checklist.md` records the release and known migration traps.

### Coding style and naming

Use CommonJS (`require`, `module.exports`) and built-in `node:` module prefixes. Match the surrounding file: `engine/handoff/` and `scripts/test/` use tabs, while `engine/task/` and `scripts/install.js` use two spaces. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames such as `build-prompt.js`. No formatter is enforced, so keep diffs focused and preserve nearby style. Avoid new dependencies unless necessary; installer code must continue to run before `npm install`.

### Testing

Tests use `node:test` with `node:assert/strict` and the `*.test.js` suffix. Add regression coverage beside the affected module. Filesystem tests must use isolated temporary directories and clean them up. Cover failure paths and atomicity as well as success, especially for installer, lock, handoff, and state-transition changes. Run the installed task and handoff suites described under **Commands**, plus `node --test scripts/test/install.test.js`, before submitting changes.

### Commits and pull requests

Follow the repository's Conventional Commit pattern, for example `feat(install): add --no-handoff flag` or `docs: add MIT LICENSE`. Keep each commit to one logical change and use `feat`, `fix`, `test`, `refactor`, or `docs`, with a scope when useful. Pull requests should describe the behavior change, link related issues, and list verification commands and results. Explicitly call out changes to templates, state-machine rules, public schemas, security-sensitive handoff behavior, or human gates. Screenshots are only needed for visible plugin or documentation-rendering changes.

## Design invariants (do not casually override)

- **Trust model**: the state-machine enforcement (write-restricted `task set`, TTY checks, lint) guards cooperative-but-fallible agents — it is not a security boundary. The real backstop is a human reviewing `git diff TASK.md` before commit.
- **Human gates are never automated**: commit/push/release, `highRisk` work, public API/schema/security changes, secrets, and external writes (`issue-sync`) all stop short of automatic execution — the pipeline halts at `REVIEW` by design.
- Korean-language user-facing strings are intentional and part of the target audience's UX — `fail(...)` in the task CLI, `HandoffError` messages and `usage()` in the dispatcher, and the installer's console output alike. Preserve the language when editing any of them.
