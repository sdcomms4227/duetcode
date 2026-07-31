---
description: READY Task를 Codex에 위임하는 duetcode 핸드오프 dispatcher 실행
argument-hint: "[--resume] [--high-risk-approved] [--timeout-min N]"
allowed-tools: Bash(npm run handoff:*), Bash(npm run task:*), Bash(git status:*), Read
---

`READY` 상태의 Active Task를 Codex에 위임한다. 저장소 루트에서 실행:

```bash
npm run handoff -- $ARGUMENTS
```

옵션:
- `--resume` — 중단된 IMPLEMENTING 복구 또는 REVIEW 보완 라운드(신규 위임 아님). 기록된 session이 있으면 그 thread를 이어가고, 세션 없이 IMPLEMENTING에 갇힌 crash는 새 thread로 복구한다(mode: recovery-new).
- `--high-risk-approved` — highRisk Task의 사람/Opus 게이트 통과 표시.
- `--timeout-min N` — 전체 Codex 실행 제한(기본 30분).

실행 후 반드시 실측한다(exit code·자연어만 신뢰하지 않는다):

```bash
npm run task -- show
npm run task -- lint
git status --porcelain
```

- **REVIEW 미도달은 exit 0이어도 실패**다. timeout·전송 실패·비정상 종료·helper 부재(무산출 exit 0)는 성공으로 해석하지 않는다.
- dispatcher는 자동 재시도·DONE 전환·rollback을 하지 않는다. 실패 시 실측 상태와 로그 경로(`.duet/state/runs/<runId>/`)를 사용자에게 보고하고 정지한다.
- 신규 위임은 `READY`에서만 가능하다. highRisk는 `--high-risk-approved` 없이는 거부된다.
