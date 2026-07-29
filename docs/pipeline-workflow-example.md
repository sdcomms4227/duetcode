# duetcode pipeline 실제 업무 흐름 예시

기능 요청 접수 → Claude 설계 → Codex 구현 → Claude 리뷰 → 사용자 승인·Git 반영까지 하나의 예시로 설명한다. 상태와 실시간 핸드오프는 저장소 루트의 `TASK.md`에 기록하며, 상태 변경은 `npm run task`로 수행한다.

> 예시 업무: 검색 화면에 생산연도 범위 필터를 추가한다.

## 1. 사용자 요청

```text
검색 화면에 생산연도 시작·종료 필터를 추가해줘. 기존 검색 조건과 함께 쓸 수 있어야 해.
```

Claude가 현재 상태와 관련 문서를 확인한다.

```bash
npm run task -- show
npm run task -- lint
```

현재 상태가 `IDLE`이면 신규 Task를 시작한다.

```bash
npm run task -- start production-year-filter \
  --objective "검색에 생산연도 범위 필터를 추가한다" \
  --requester "사용자" \
  --designer "Opus 4.8"
```

## 2. Claude 분석·설계

Claude는 코드와 필독 문서를 조사하고 `TASK.md` 본문(요구사항·완료 조건, 필독 문서·불변식, 영향 범위, 확정된 설계·미확정, 검증 방법·허용하지 않는 회귀)을 채운 뒤 역할·checkpoint를 설정하고 READY로 전환한다.

```bash
npm run task -- set roles.implementer=gpt-5.6-sol
npm run task -- set "roles.reviewer=Opus 4.8"
npm run task -- set designCheckpoint=<설계-커밋-SHA>
npm run task -- set status=READY
```

공개 API·DB 스키마·보안 정책처럼 영향이 큰 결정을 바꿔야 하면 READY 전환 전에 사용자 결정을 받는다.

## 3. Codex 구현 (핸드오프)

Claude는 `READY` 상태에서 저장소 dispatcher를 한 번 실행한다.

```bash
npm run handoff
# highRisk:true이고 사람/Opus 게이트가 끝났으면
npm run handoff -- --high-risk-approved
```

dispatcher는 필수 섹션의 `- 미정` 플레이스홀더·비READY·highRisk 미승인·활성 lock을 Codex 호출 전에 거부한다. 통과하면 prompt를 stdin으로 전달하고 `READY→IMPLEMENTING`을 수행하며 cwd=저장소 루트·sandbox=`workspace-write`·기본 timeout=30분을 고정한다.

중단된 IMPLEMENTING 실행을 이어갈 때만 명시적으로 재개한다.

```bash
npm run handoff -- --resume
```

종료 후에는 exit code나 자연어만 믿지 않고 실제 상태를 확인한다.

```bash
npm run task -- show
npm run task -- lint
git status --porcelain
```

timeout·비정상 종료·전송 실패·REVIEW 미도달은 실패다. Codex가 구현·로컬 검증을 마치면 먼저 REVIEW로 전환한다(REVIEW 진입 시 CLI가 미검증 verification 객체를 자동 생성).

```bash
npm run task -- set status=REVIEW
```

## 4. Claude 리뷰와 보완

Claude는 구현 결과를 요구사항·설계·코드·문서·설정과 대조한다. 보완이 필요하면 Codex로 되돌린다.

```bash
npm run task -- set status=IMPLEMENTING        # 구현 보완
npm run task -- set status=READY --design-checkpoint <새-SHA>   # 설계 변경
```

두 루프백 모두 기존 verification을 초기화한다(이전 PASS 재사용 불가).

## 5. 검증 결과 기록

```bash
npm run task -- record-verification --status PASSED --failed-count 0
# 환경 제약으로 일부 미실행 시 (사유를 TASK.md에 기록)
npm run task -- record-verification --status PARTIAL --failed-count 0
```

PARTIAL로 완료하려면 사용자가 실제 터미널에서 승인한다.

```bash
npm run task -- approve-partial
# PARTIAL 검증을 승인하려면 APPROVE를 입력하세요: APPROVE
```

## 6. 사용자 최종 확인

```bash
git status
git diff
```

요청한 기능 일치, 예상치 못한 파일 포함 여부, 비밀값 포함 여부, `TASK.md` 검증 기록과 실제 결과 일치를 확인한다. **사용자가 명시적으로 요청한 경우에만** AI가 commit·push·PR·외부 Issue 쓰기를 수행한다.

## 7. DONE, 커밋

```bash
npm run task -- set status=DONE
npm run task -- lint
git add <관련-파일> TASK.md
git commit -m "feat(search): 생산연도 범위 검색 추가"
```

CI는 `npm ci` + `npm run task:lint` + `npm run task:test`(+ 핸드오프 설치 시 `handoff:test`)로 현재 TASK 상태와 엔진을 검사한다(과거 전환 이력은 비교하지 않는다).

## 8. Task 종료와 IDLE 복원

DONE 상태의 `TASK.md`가 커밋되어 clean이면 초기화한다.

```bash
npm run task -- reset
```

## 9. 예외 흐름

```bash
npm run task -- block "테스트 계정 발급 대기"
npm run task -- unblock          # 차단 직전 활성 상태로 복귀
npm run task -- cancel "우선순위 변경으로 중단"
npm run task -- supersede other-task-id "요구사항 전면 변경"
```

CANCELLED·SUPERSEDED는 종결 이유를 보존해야 reset할 수 있다(종결 상태 커밋 또는 검증 가능한 archive 참조).

## 운영 주의사항

- 옵션이 있는 명령은 PowerShell/npm 조합에서 옵션이 제거될 수 있으므로 `npm run task -- ...` 직접 실행을 권장한다.
- `start`는 `## Active Task` 이하 본문을 `- 미정` 스켈레톤으로 교체한다. 설계자는 READY 전환 전에 이를 실제 내용으로 채워야 하며, 미교체 시 lint가 READY를 거부한다.
- `verification.*`·`blocked.*`·`closure.*`는 `task set`으로 직접 수정하지 않고 전용 명령을 쓴다.
- 구현 범위는 상태머신(코어), Codex 핸드오프 dispatcher, 자동 HTTP 검증 하니스 `task verify` 셋이다.
- `task verify`는 REVIEW에서 `.duet/verify.json`을 읽어 비파괴 스모크(GET/HEAD 전용)를 돌리고 결과를 `verification`에 직접 쓴다. 설정이 없는 검사는 건너뛰고 `PARTIAL`이 되며, `PARTIAL`로 DONE에 가려면 여전히 `approve-partial`이 필요하다. 운영으로 읽히는 프로파일에서는 실행되지 않는다 — 그건 사람 게이트다. 자세한 규칙은 [pipeline-design.md §9](pipeline-design.md)에 있다.
