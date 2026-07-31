---
name: pipeline
description: duetcode 파이프라인 운영 매뉴얼 — TASK.md 상태머신으로 Task를 진행하고 Claude↔Codex 핸드오프를 오케스트레이션한다. Task 시작·상태 전환·구현 위임·검증 기록·완료를 다룰 때 사용. IDLE→DESIGN→READY→IMPLEMENTING→REVIEW→DONE 전환, 사람 게이트, verification 규칙을 따른다.
---

# duetcode pipeline 운영

`TASK.md`가 현재 진행 중인 단일 Task의 단일 소스다. 상태 변경·lint는 반드시 `npm run task`로 한다(front matter 직접 편집 금지). 프로즈 본문(요구사항·근거·검증 로그)만 사람/에이전트가 편집한다.

## 상태머신

```
IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE
                  ↑           ↑          ││
            READY ←───────────┘          ││ REVIEW→IMPLEMENTING (구현 보완)
                  └───────────────────────┘ REVIEW→READY (설계 변경, --design-checkpoint 필수)
```

허용 전환만 통과한다. `REVIEW→IMPLEMENTING`·`REVIEW→READY` 루프백은 verification을 초기화한다.

## 핵심 명령

```bash
npm run task -- show
npm run task -- lint
npm run task -- start <id> --objective <목표> --requester <요청자> --designer <설계자>
npm run task -- set roles.implementer=<모델>  "roles.reviewer=<모델>"  designCheckpoint=<SHA>
npm run task -- set status=READY            # IMPLEMENTING / REVIEW / DONE도 같은 형식
npm run task -- set status=READY --design-checkpoint <v>  # REVIEW→READY 전용
npm run task -- record-verification --status PASSED --failed-count <N> [--evidence "<검증 명령>"]  # FAILED / PARTIAL도 같은 형식
npm run task -- verify                   # REVIEW 전용, .duet/verify.json 기반 비파괴 HTTP 스모크
npm run task -- approve-partial          # TTY 필요
npm run task -- block "<사유>"
npm run task -- unblock
npm run task -- cancel "<사유>"
npm run task -- supersede <대체id> "<사유>"
npm run task -- archive <ref>              # CANCELLED·SUPERSEDED 전용; commit:<sha> 또는 docs:<path>
npm run task -- reset
```

`verification.*`·`blocked.*`·`closure.*`는 `task set`으로 못 바꾼다 — 각 전용 명령만.

### `task verify` (자동 검증 하니스)

`.duet/verify.json`(커밋 제외, 샘플은 npm이 설치한 `node_modules/duetcode/templates/verify.example.json`)에 정의한 비파괴 HTTP 스모크를 돌려 결과를 `verification`에 직접 쓴다. 설정이 없으면 CLI가 현재 설치된 패키지의 절대 샘플 경로를 알려주고 멈춘다. 알아둘 제약:

- **REVIEW에서만** 실행된다. 결과가 `FAILED`/`PARTIAL`이면 exit 1이지만 **기록은 이미 끝난 뒤**다 — 다시 돌릴 필요 없이 `show`로 확인하면 된다.
- **운영으로 읽히는 프로파일(`prod`/`production`/`live`/`release`/`main` 등)에서는 실행되지 않는다.** `allowedProfiles`로도 완화할 수 없다 — 운영 검증은 사람 게이트다. 이 거부를 만나면 우회하지 말고 사용자에게 보고한다.
- 비파괴만 가능하다: `GET`/`HEAD`, 본문 없음, 리다이렉트 미추적. 설정에 쓰기 요청을 넣으려 하지 않는다.
- 설정이 없는 검사(계정 환경변수·recordId 미설정)는 건너뛰고 `PARTIAL`이 된다. `PARTIAL`로 DONE에 가려면 여전히 `approve-partial`이 필요하다.
- `record-verification`을 대체하지 않는다. HTTP 스모크로 덮이지 않는 검증(단위 테스트 등)은 `record-verification --evidence`로 기록한다.

## 진행 방식

1. **DESIGN(Claude)**: `start` 후 프로즈 4섹션(요구사항·완료 조건 / 필독 문서·불변식 / 영향 범위 / 확정된 설계·미확정)을 채운다. `- 미정` 플레이스홀더가 남으면 READY·핸드오프가 거부된다.
2. **READY**: 역할(implementer·reviewer)·designCheckpoint 설정 후 `set status=READY`.
3. **IMPLEMENTING(Codex)**: `npm run handoff`로 위임(→ 핸드오프 섹션). Codex는 구현·로컬 검증 후 `set status=REVIEW`.
4. **REVIEW(Claude)**: 요구사항·설계·코드·문서·설정 정합성 대조. 보완이면 루프백, 통과면 `record-verification`(HTTP 스모크 설정이 있는 프로젝트라면 `verify`). **`--evidence "<검증 명령>"`을 함께 준다** — 그 명령을 실제로 실행해 exit code와 출력 해시를 남긴다. 없이 기록하면 "테스트를 돌렸다"는 자기 신고에 지나지 않는다. 증거의 exit code가 0이 아닌데 PASSED로 기록하면 lint가 거부한다.
5. **DONE**: `(PASSED && failed==0)` 또는 `(PARTIAL && failed==0 && approve-partial 승인)`일 때만 `set status=DONE`. 코드 작성 완료 ≠ DONE.

## 핸드오프 (Claude → Codex)

```bash
npm run handoff                       # READY에서 신규 위임
npm run handoff -- --high-risk-approved   # highRisk 게이트 통과 표시
npm run handoff -- --resume           # IMPLEMENTING 복구/REVIEW 보완. 세션 있으면 이어가고, 세션 없는 crash는 새 thread(recovery-new)
```

**성공을 exit code로 판정하지 않는다.** 종료 후 `task show`(REVIEW 도달)·`task lint`·`git status --porcelain`을 실측한다. REVIEW 미도달은 exit 0이어도 실패이며, 자동 재시도·DONE 전환·rollback을 하지 않고 정지한다.

## 사람 게이트 (자동화 금지)

- 커밋·push·release는 **사용자 명시 요청 시에만**. 파이프라인은 REVIEW에서 정지한다.
- 하이리스크(`highRisk:true`)는 designer에 항상, reviewer에는 READY부터 Opus 필수(lint 강제) + 핸드오프 전 사람/Opus 게이트.
- 공개 API·DB 스키마·보안 정책·비밀값 변경은 구현 전 사용자 확인.
- `issue-sync`(외부 쓰기)·`approve-partial`은 사람 실행.
- 최종 방어선은 커밋 전 사람의 `git diff TASK.md` 검토다.

자세한 규칙은 `docs/duetcode-pipeline-design.md`, 단계별 예시는 `docs/duetcode-pipeline-workflow-example.md` 참조.
