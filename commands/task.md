---
description: duetcode TASK.md 상태머신 CLI (show/lint/start/set/record-verification/verify/approve-partial/block/unblock/cancel/supersede/reset/archive/issue-sync)
argument-hint: <subcommand> [args...]
allowed-tools: Bash(npm run task:*), Read
---

저장소 루트에서 다음을 실행하고 결과를 해석해 사용자에게 보고한다:

```bash
npm run task -- $ARGUMENTS
```

규칙:
- 상태 전환·필드 변경은 반드시 이 CLI로 한다. `TASK.md` front matter를 직접 편집하지 않는다.
- `verification.*`·`blocked.*`·`closure.*`는 전용 서브명령(`record-verification`/`verify`/`approve-partial`, `block`/`unblock`, `cancel`/`supersede`/`archive`)으로만 바꾼다.
- `verify`는 `.duet/verify.json` 기반 비파괴 HTTP 스모크를 REVIEW에서 실행해 결과를 기록한다. `FAILED`/`PARTIAL`이면 exit 1이지만 기록은 끝난 뒤이므로 재실행하지 않는다. 운영으로 읽히는 프로파일에서는 거부되며, 그 거부는 우회하지 말고 사용자에게 보고한다.
- `approve-partial`은 대화형 TTY가 필요하다 — 비대화형 실행에서는 사용자에게 직접 터미널 실행을 안내한다.
- 인자가 없으면 `show`로 현재 상태를 보여준다.
- 자세한 상태머신·게이트는 `pipeline` 스킬 / `docs/duetcode-pipeline-design.md` 참조.
