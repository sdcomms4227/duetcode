# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

duetcode is a **Claude Code plugin**, not an app. It ships a self-contained state-machine + human-gate pipeline (`engine/`) that `scripts/install.js` copies into a *target* repo's `tools/`. This repo itself has no root `package.json` — `engine/task` and `engine/handoff` are developed and tested here, then installed elsewhere verbatim.

Two independent engines live under `engine/`:
- `engine/task/` — the `TASK.md` state-machine CLI (`index.js` + `lib.js`)
- `engine/handoff/` — the Codex handoff dispatcher (`dispatch.js`, `lib.js`, `build-prompt.js`, `parse-result.js`)

## Commands

There is no root `package.json`, and the engine's own tests hard-code `tools/task/index.js` / `tools/handoff/*` paths (they run against an *installed* copy, not `engine/` directly — see `engine/task/test/helpers.js`). To run the test suites, self-install into the repo root first, into a scratch dir outside the repo:

```bash
node scripts/install.js --target <scratch-dir>   # or --target . to self-install (creates tools/, package.json, TASK.md, docs/, .github/ at repo root — do NOT commit these; they're install artifacts, not source)
cd <scratch-dir> && npm install                  # pulls in the yaml devDependency
npm run task:test        # node --test tools/task/test/*.test.js
npm run handoff:test      # node --test tools/handoff/test/*.test.js
npm run task:lint         # validates TASK.md against the current state
```

Installer flags: `--force` refreshes `tools/task`/`tools/handoff` from `engine/` (overwrites local engine edits); `--engine-only --force` syncs only `tools/`, leaving docs/package.json/TASK.md/CI untouched — this is how an already-installed target repo picks up canonical engine fixes; `--no-handoff` installs the core (state machine + lint + CI) without the Codex dispatcher.

Once installed in a target repo, the state machine is driven via `node tools/task/index.js <command>` (aliased to `npm run task`); see "State machine" below.

## Architecture

### Single source of truth: `TASK.md`

The entire pipeline pivots on one file, `TASK.md`, in the *target* repo: YAML front matter is the machine-readable state, prose below it is human detail. Only one Active Task exists at a time. `engine/task/lib.js` parses it with a strict `---\n...\n---` front-matter regex (`parseSource`) and rewrites it losslessly via `yaml`'s `parseDocument`/`toString` (preserves comments/formatting).

### State machine (`engine/task/lib.js` + `index.js`)

States: `IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE`, with `BLOCKED` reachable from any `ACTIVE` state and `CANCELLED`/`SUPERSEDED` as terminal off-ramps. `TRANSITIONS` in `lib.js` is the authoritative adjacency map — `set status=X` on the CLI calls `transition()`, which enforces it.

`validate()` in `lib.js` is where most of the domain logic actually lives, not `index.js`:
- Required fields escalate by state (e.g. `roles.implementer`/`roles.reviewer`/`designCheckpoint` only required from `READY` onward).
- `highRisk: true` forces `Opus` to appear in `roles.designer` (and `roles.reviewer` once past DESIGN) — a machine-enforced human-in-the-loop gate for risky work.
- Reaching `READY`+ requires specific `### ` sections in the prose body to be non-placeholder (`meaningful()` rejects `없음`/`미정`/`TODO`/`-`).
- `DONE` requires `verification.status === 'PASSED'` (or `PARTIAL` with `partialApproved === true`) and `failedCount === 0` (`canDone()`).
- `reset` from a terminal state requires the TASK.md file itself to be committed clean (`requireCleanShare`) unless it's already archived — this is what stops silent loss of a closed task's record.

`start` replaces the prose body with `STARTER_BODY`, a placeholder skeleton — this is deliberate, so a new task can never inherit a stale previous task's write-up (see the code comment in `lib.js` referencing the past defect this fixed).

`approve-partial` is the one interactive command: it requires both stdin and stdout to be a real TTY and reads a typed `APPROVE` confirmation — this is intentionally not scriptable.

### Handoff dispatcher (`engine/handoff/`)

`dispatch.js` delegates `IMPLEMENTING`-state work to the `codex` CLI as a subprocess, then parses its result back into `TASK.md`. Key mechanics in `lib.js`:
- `EXIT_CODES`: `SUCCESS`, `INTERNAL`, `GUARD`, `TIMEOUT`, `TRANSPORT`, `INCOMPLETE` — dispatch's own exit code communicates *why* a run didn't complete, distinct from Codex's exit code.
- `acquireLock`/`releaseLock` under `HANDOFF_STATE_DIR` (default `tools/handoff/state/`, git-ignored) make concurrent dispatch invocations mutually exclusive.
- `--resume` reuses a recorded `thread_id` from session state — for continuing a REVIEW round or recovering from an IMPLEMENTING crash without losing Codex conversation context.
- `--high-risk-approved` is the CLI-side acknowledgment of the `highRisk` human/Opus gate before a risky task is allowed to dispatch.
- `redactText` / `sanitizeFile` exist because Codex output and prompts get logged to `HANDOFF_STATE_DIR` — secrets must not leak into that state.

`build-prompt.js` assembles what Codex actually receives from `TASK.md`'s current state; `parse-result.js` (`ResultParser`) interprets Codex's structured response back into a status/outcome dispatch.js can act on.

### Installer (`scripts/install.js`)

Deterministic and idempotent by design: default behavior is "create if missing, never touch existing files" (`copyDir`/`ensureFileFromTemplate` skip-if-exists). `--force` is the only way to overwrite the engine directories. `mergePackageJson` additively merges the `templates/package-json-snippet.json` scripts/deps into the target's `package.json`, reporting (not silently overwriting) any script-name conflicts. The installer intentionally uses **only Node built-ins** (no `yaml` import) because it must run before `npm install` has populated the target's `devDependencies`.

### Plugin surface

`commands/{task,handoff}.md` define the `/duetcode:task` and `/duetcode:handoff` slash commands; `skills/pipeline-install/` and `skills/pipeline/` are the bootstrap-installer and operating-manual skills respectively, invoked by name once the plugin is installed via the marketplace.

## Contributor guidelines

### Project structure

Treat `engine/task/` and `engine/handoff/` as the canonical runtime sources; installed `tools/` directories are generated copies. Installer logic and tests live in `scripts/install.js` and `scripts/test/`. Plugin commands are in `commands/`, reusable workflow instructions in `skills/`, generated-file sources in `templates/`, and design references in `docs/`. Update the canonical engine or template rather than a temporary installation artifact.

### Coding style and naming

Use CommonJS (`require`, `module.exports`) and built-in `node:` module prefixes. Match the surrounding file: handoff and installer modules primarily use tabs, while task modules primarily use two spaces. Use `camelCase` for functions and variables, `UPPER_SNAKE_CASE` for constants, and kebab-case filenames such as `build-prompt.js`. No formatter is enforced, so keep diffs focused and preserve nearby style. Avoid new dependencies unless necessary; installer code must continue to run before `npm install`.

### Testing

Tests use `node:test` with `node:assert/strict` and the `*.test.js` suffix. Add regression coverage beside the affected module. Filesystem tests must use isolated temporary directories and clean them up. Cover failure paths and atomicity as well as success, especially for installer, lock, handoff, and state-transition changes. Run the installed task and handoff suites described under **Commands**, plus `node --test scripts/test/*.test.js`, before submitting changes.

### Commits and pull requests

Follow the repository's Conventional Commit pattern, for example `feat(install): add --engine-only flag` or `docs: add MIT LICENSE`. Keep each commit to one logical change and use `feat`, `fix`, `test`, `refactor`, or `docs`, with a scope when useful. Pull requests should describe the behavior change, link related issues, and list verification commands and results. Explicitly call out changes to templates, state-machine rules, public schemas, security-sensitive handoff behavior, or human gates. Screenshots are only needed for visible plugin or documentation-rendering changes.

## Design invariants (do not casually override)

- **Trust model**: the state-machine enforcement (write-restricted `task set`, TTY checks, lint) guards cooperative-but-fallible agents — it is not a security boundary. The real backstop is a human reviewing `git diff TASK.md` before commit.
- **Human gates are never automated**: commit/push/release, `highRisk` work, public API/schema/security changes, secrets, and external writes (`issue-sync`) all stop short of automatic execution — the pipeline halts at `REVIEW` by design.
- Korean-language CLI error/usage strings (`fail(...)` messages) are intentional and part of the target audience's UX — preserve the language when editing `index.js`/`lib.js` user-facing strings.
