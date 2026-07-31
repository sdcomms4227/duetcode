# CLAUDE.md

This file is the single source of repository instructions for coding agents working here — Claude Code and Codex alike. `AGENTS.md` points at this file so both read the same rules; keep it that way and update this file rather than forking guidance.

## What this repo is

duetcode is an **npm package and a Claude Code plugin**, not an app. It ships a state-machine + human-gate pipeline (`engine/`) that target repos install as a devDependency and invoke through the `duet-task` / `duet-handoff` binaries. `scripts/install.js` (`duet-init`) no longer copies the engine — it only bootstraps what the *target* repo owns: `TASK.md`, protocol docs, CI, and `.gitignore` entries.

Neither engine infers anything from its own path, so both behave identically under `node_modules/`, a checkout, or anywhere else. Three rules live in `engine/task/lib.js` because **both engines need them** and a second copy would let the two drift — when you need one, import it rather than re-implementing it next to the caller:

- `resolveRepoRoot` — where the repo root is (see below).
- `terminateProcessTree` — kill a spawned process *tree*: handoff for codex, `task verify` for its smoke server. Killing only the parent leaves the grandchild holding the port. **It is platform-split and POSIX needs the caller's cooperation**: Windows gets `taskkill /T`, while POSIX has no way to name "all descendants" and must kill the process *group*, which works only if the child was spawned `detached: true` — so the caller passes `{ group: true }` to say it did. Never attempt `kill(-pid)` speculatively: if that pid matches another group's pgid you kill someone else's processes, and in CI that can be the runner itself. Both callers now spawn detached on POSIX and pass the flag. **For the handoff dispatcher that came with a second obligation**: `detached` puts codex in its own session, so the terminal's Ctrl-C no longer reaches it — without a signal handler the dispatcher would die and leave codex orphaned, still editing the repo, which is worse than the leak it fixes. So `installInterruptHandlers` (SIGINT/SIGTERM/SIGHUP) kills the tree, releases the lock, and exits `INCOMPLETE` (5). Treat `detached` and that handler as one change: never add one without the other.
- `resolveSpawn` — make a command spawnable per platform. Windows `.cmd`/`.bat` cannot run without a shell (Node rejects it with `EINVAL`), while `shell: true` merely concatenates args and breaks paths with spaces, so it wraps the call in `cmd.exe /d /s /c` with our own quoting plus `windowsVerbatimArguments`. Both engines use it: `task verify` for `server.command`, handoff for `HANDOFF_CODEX_CMD` (an npm-installed codex is `codex.cmd`).

The repo-root rule is the oldest of the three and the reason the pattern exists: `resolveRepoRoot` lives in `engine/task/lib.js` (`DUET_REPO_ROOT` → `git rev-parse --show-toplevel` → cwd) and `engine/handoff/lib.js` imports it — two independent copies would let the same command touch different `TASK.md` files. Handoff resolves `TASK.md` and `.duet/state/` against that root. The task CLI resolves its state file through `resolveTaskFile`, which layers on top: `TASK_STATE_FILE` → a `TASK.md` in cwd → the repo root's `TASK.md`. cwd wins over the root, so invoking from the repo root behaves exactly as it always did; only subdirectory invocations changed, from "file not found" to finding the repo's `TASK.md`. When none of the three exist, the error names the path it looked for and points at `TASK_STATE_FILE`.

Two engines live under `engine/`, installed as separate directories but **not** mutually independent:
- `engine/task/` — the `TASK.md` state-machine CLI (`index.js` + `lib.js`, plus `verify.js` for the `task verify` smoke harness). Standalone at runtime; `--no-handoff` configures only its scripts, although npm still installs the complete `duetcode` package.
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
npm run lint:secrets   # reject credential-shaped *literals* anywhere in the repo
```

`lint:secrets` exists because redaction fixtures have to look like real credentials, and GitHub's push protection judges by shape alone — a literal fixture once blocked the first push and cost a full `git filter-branch` history rewrite. The rule is therefore: **assemble such fixtures at runtime** (`'ASIA' + 'B'.repeat(16)`), never as a literal. `scripts/check-secret-literals.js` enforces it and `scripts/test/secret-literals.test.js` runs the same check under `npm test`, including samples that must be caught — a lint that matches nothing would otherwise pass silently. It scans dot-directories too — skipping them once hid the published `.claude-plugin/` from the check, which is the same as a check that silently passes. `ALLOWED_LITERALS` holds only values GitHub recognizes as public examples (currently one AWS example key), and a test pins its size, because a growing allowlist is how this check dies. It is not a security boundary; it only keeps the next push from turning into a history rewrite.

`package.json`'s `version` is the source for the install specs in `README.md`, `skills/pipeline-install/SKILL.md`, and `templates/package-json-snippet.json`, and for `.claude-plugin/plugin.json`. `scripts/sync-version.js` keeps them aligned; `scripts/test/version-sync.test.js` catches drift. Historical versions in release records are intentionally excluded. Bump with `npm version <newversion> --no-git-tag-version` — the `version` lifecycle syncs the references but must not commit or tag, because committing and tagging a release is a human gate.

**Releasing here means pushing the tag — this package is never published to npm** (decided 2026-07-29; the reasoning is in `docs/release-checklist.md` §7 under "npm 발행 — 하지 않는다"). Do not offer or run `npm publish` as the next step of a release: target repos install via `github:sdcomms4227/duetcode#<tag>`, so a pushed tag *is* the release. The `duetcode` name on the public registry is deliberately left unclaimed.

`scripts/test/docs-consistency.test.js` is the same idea applied to the docs: it walks every Markdown file in the repo and fails on a local link or `#fragment` whose target does not exist, a `§N` cross-doc link that drops the fragment and so opens only the document's first screen, an environment-specific Windows absolute path, an unbalanced code fence, and unparseable front matter in the shipped `commands/` and `skills/` files. It also holds the boundary that `package.json`'s `files` creates: a relative link out of a *packaged* Markdown file must resolve to something else that is packaged, because `docs/` ships only two of its files — that is why `README.md` points at `engine-externalization.md`, `public-release-readiness.md`, and `release-checklist.md` by absolute GitHub URL rather than relative path. Only two exemptions exist, both narrow: `templates/collaboration-protocol.md`'s `../TASK.md` resolves in the *target* repo after install, and the explicit `<a id="section-N">` anchors in `docs/` exist because a `§N` link needs a stable target that renaming a Korean heading cannot break.

Test scripts name files explicitly instead of globbing — `test/run.js` enumerates `*.test.js` itself. Both shorthands behave differently across shells and Node versions (measured): a glob is expanded by POSIX shells but not by `cmd.exe`, which is what Windows' npm uses, so the literal pattern reaches Node — and Node only expands globs from v21, leaving v18/20 to fail with `Could not find`. A directory argument diverges the other way: v18/20 recurse into it, v22 tries to load the path as a module and dies with `MODULE_NOT_FOUND`. Enumerating files removes every one of those branches.

To exercise the *bootstrap* path, point it at a scratch directory outside this repo. Until the package is published, wire the dependency with a `file:` spec to test the real resolution path:

```bash
node scripts/install.js --target <scratch-dir>
cd <scratch-dir>
npm pkg set devDependencies.duetcode=file:/path/to/duetcode
npm install && npm run task:lint
```

Bootstrap flags: `--no-handoff` omits the `handoff` script (it does **not** uninstall an existing one); `--target <path>` chooses the target. There is no `--force` or `--engine-only` any more — those existed to manage target-owned engine directories, and the installer creates no such copy now.

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

`verify` (`engine/task/verify.js`) is the third and last writer of `verification`, and the only one where the CLI decides the status rather than recording what a human reports — so its surface is deliberately narrow. It is `REVIEW`-only like `record-verification`, reads `.duet/verify.json` from the repo root, and enforces four things that are not configurable away: a profile whose name reads as production is rejected even when listed in `allowedProfiles` (verifying production is a human gate, `docs/pipeline-design.md` §10 item 1); only `GET`/`HEAD` with no body, no redirect following, and no origin outside `baseUrl`; the whole plan is built before any request is sent, so a destructive check in the config means *nothing* is sent; and only a server the harness itself spawned is ever killed, on every exit path. Missing configuration skips just that check and yields `PARTIAL` — otherwise "not configured" would be indistinguishable from "broken" — and zero executed checks is `PARTIAL`, never `PASSED`. Exceeding `maxDurationMs` **fails** the remaining checks rather than skipping them, the same rule handoff applies to timeouts. The evidence it writes carries an `exitCode` matching its own verdict, so `validate()`'s "PASSED with non-zero exit code" rejection applies to the harness too.

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

Bootstrap only — it creates what the target repo *owns* and never the engine. Deterministic and idempotent, but "idempotent" is not "read-only": `ensureFileFromTemplate` and `ensureDirectory` are skip-if-exists (the latter creates `.duet/` so `task verify`'s config has a home — it is git-ignored, so nothing shows up in `git diff`), while `mergePackageJson` rewrites the target's `package.json` and `appendGitignore` merges into its `.gitignore` **entry by entry** (a snippet that is only partly present still gets its missing lines — an all-or-nothing check would mean new entries never reach existing installs). Both only ever add.

Upgrading an existing install is the harder half, and the rules are deliberate:
- A script is replaced only when its current value matches a known previous value in `LEGACY_SCRIPTS` (e.g. `node tools/task/index.js` → `duet-task`). Anything else might be the user's own edit, so it is reported as a conflict and left untouched.
- Leftovers from the copied-engine era — `task:test` / `handoff:test` scripts, a stale `tools/` directory — are **reported, never deleted**. Removing a user's files is not the installer's call.
- `--no-handoff` skips the `handoff` script but does **not** remove an existing handoff setup. It means "don't add", not "uninstall".

The installer intentionally uses **only Node built-ins** (no `yaml` import) because it runs before the target's `npm install` has fetched anything.

### Plugin surface

`commands/{task,handoff}.md` define the `/duetcode:task` and `/duetcode:handoff` slash commands; `skills/pipeline-install/` and `skills/pipeline/` are the bootstrap-installer and operating-manual skills respectively, invoked as `duetcode:pipeline-install` / `duetcode:pipeline` once the plugin is installed via the marketplace.

## Contributor guidelines

### Project structure

`engine/task/` and `engine/handoff/` are the canonical runtime sources and the only source copy to edit — target repos consume the npm-installed package from `node_modules`, so there is no generated target-owned duplicate to keep in sync. Bootstrap logic and its tests live in `scripts/install.js` and `scripts/test/`. Plugin commands are in `commands/`, reusable workflow instructions in `skills/`, generated-file sources in `templates/`, and design references in `docs/`. Update the canonical engine or template rather than a temporary installation artifact.

Three docs are worth reading before specific kinds of change: `docs/pipeline-design.md` is the precise spec for the state machine, verification, and gates — consult it before altering any rule, and keep it in sync when you do. `docs/engine-externalization.md` is the implemented design behind the engine's location independence and its shipping as a dependency — it records why `REPO_ROOT` and `TASK_CLI` resolve the way they do, so read it before touching those path assumptions. `docs/release-checklist.md` records the release and known migration traps.

### Coding style and naming

Use CommonJS (`require`, `module.exports`) and built-in `node:` module prefixes. Match the surrounding file: `engine/handoff/` and `scripts/test/` use tabs, while `engine/task/` and `scripts/install.js` use two spaces. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames such as `build-prompt.js`. No formatter is enforced, so keep diffs focused and preserve nearby style. Avoid new dependencies unless necessary; installer code must continue to run before `npm install`.

### Testing

Tests use `node:test` with `node:assert/strict` and the `*.test.js` suffix. Add regression coverage beside the affected module. Filesystem tests must use isolated temporary directories and clean them up. Cover failure paths and atomicity as well as success, especially for installer, lock, handoff, and state-transition changes. Run `npm test` before submitting changes — it chains all three suites described under **Commands**. Do not substitute `node --test scripts/test/install.test.js`: `scripts/test/run.js` enumerates every `*.test.js` in that directory, so naming one file silently skips the version-sync, secret-literal, and doc-consistency checks.

### Commits and pull requests

Follow the repository's Conventional Commit pattern, for example `feat(install): add --no-handoff flag` or `docs: add MIT LICENSE`. Keep each commit to one logical change and use `feat`, `fix`, `test`, `refactor`, or `docs`, with a scope when useful. Pull requests should describe the behavior change, link related issues, and list verification commands and results. Explicitly call out changes to templates, state-machine rules, public schemas, security-sensitive handoff behavior, or human gates. Screenshots are only needed for visible plugin or documentation-rendering changes.

## Design invariants (do not casually override)

- **Trust model**: the state-machine enforcement (write-restricted `task set`, TTY checks, lint) guards cooperative-but-fallible agents — it is not a security boundary. The real backstop is a human reviewing `git diff TASK.md` before commit.
- **Human gates are never automated**: commit/push/release, `highRisk` work, public API/schema/security changes, secrets, and external writes (`issue-sync`) all stop short of automatic execution — the pipeline halts at `REVIEW` by design.
- Korean-language user-facing strings are intentional and part of the target audience's UX — `fail(...)` in the task CLI, `HandoffError` messages and `usage()` in the dispatcher, and the installer's console output alike. Preserve the language when editing any of them.
