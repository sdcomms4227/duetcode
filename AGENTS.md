# Repository Guidelines

The authoritative repository instructions live in [`CLAUDE.md`](./CLAUDE.md) — architecture, development and test commands, coding conventions, contribution requirements, and safety invariants. **Read it before inspecting, modifying, testing, or reviewing this repository.** If guidance conflicts or needs updating, change `CLAUDE.md` rather than this file, so every agent works from one source.

Four rules are easy to break before you have read it, so they are repeated here:

1. **`engine/` is the source; `tools/` is a generated copy.** Fix things in `engine/task/`, `engine/handoff/`, `templates/`, or `scripts/install.js` — never in an installed `tools/` directory, whose contents are overwritten on the next `--force` install.
2. **Tests run against an installed copy, not `engine/`.** Install into a scratch directory *outside* this repo, `npm install` there, then run `npm run task:test` and `npm run handoff:test`. Do not self-install into the repo root — none of the generated artifacts are gitignored here. The installer suite is the exception and runs from the repo root: `node --test scripts/test/install.test.js`.
3. **Korean user-facing strings stay Korean.** CLI errors, dispatcher messages, and installer output are in Korean deliberately; that is the target audience's UX, not an oversight.
4. **Human gates are not yours to automate.** No commit, push, or release unless the user explicitly asks. The pipeline is designed to stop at `REVIEW` and hand back to a person.
