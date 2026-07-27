---
id: null
status: IDLE
objective: null
requester: null
roles: null
branch: __BRANCH__
designCheckpoint: null
issue: null
highRisk: false
verification: null
blocked: null
closure: null
updated: __UPDATED__
---

# TASK.md — Active Task 상태

이 파일은 **현재 진행 중인 단일 Task의 실시간 상태만** 담는다. 협업 규약과 개발 가이드는 저장소의 에이전트 지침 문서(예: `CLAUDE.md`/`AGENTS.md`)와 `docs/duetcode-pipeline-design.md`가 단일 소스다.

- 최상단 YAML front matter = 기계-판독 상태(단일 소스). 상태 전환·lint는 `npm run task -- <명령>`으로만 수행한다.
- 그 아래 프로즈 = 사람용 상세(요구사항·근거·검증 로그).
- 동시에 하나의 Active Task만 유지한다.

## Active Task

(IDLE — 활성 Task 없음. `npm run task -- start <id> --objective <목표> --requester <요청자> --designer <설계자>`로 시작한다. start가 이 아래 본문을 새 Task 스켈레톤으로 교체한다.)
