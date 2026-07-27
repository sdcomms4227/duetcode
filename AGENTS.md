# Repository Guidelines

The authoritative repository instructions live in [`CLAUDE.md`](./CLAUDE.md) — architecture, development and test commands, coding conventions, contribution requirements, and safety invariants. **Read it before inspecting, modifying, testing, or reviewing this repository.** If guidance conflicts or needs updating, change `CLAUDE.md` rather than this file, so every agent works from one source.

Four rules are easy to break before you have read it, so they are repeated here:

1. **`engine/` is the source and the only copy.** Target repos consume it from `node_modules`, so fixes go in `engine/task/`, `engine/handoff/`, `templates/`, or `scripts/install.js` — there is no generated duplicate to edit by mistake.
2. **Tests run here, against `engine/` directly.** `npm install && npm test` from the repo root. No self-install, no scratch directory — that requirement disappeared when the engine stopped being copied.
3. **Korean user-facing strings stay Korean.** CLI errors, dispatcher messages, and installer output are in Korean deliberately; that is the target audience's UX, not an oversight.
4. **Human gates are not yours to automate.** No commit, push, or release unless the user explicitly asks. The pipeline is designed to stop at `REVIEW` and hand back to a person.
