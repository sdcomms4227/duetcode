# duetcode pipeline 설계

> `TASK.md` 단일 상태 파일을 축으로, 설계·구현·검증 에이전트(Claude↔Codex)의 구현 배턴을 규칙에 맞춰 넘기는 **상태머신 + 사람 게이트** 파이프라인. 엔진은 저장소 네이티브(순수 Node.js + `yaml`), AI는 어댑터다.

## 1. 목표 / 비목표

**목표**
- Task 상태머신의 전환·필수필드·검증 판정을 **기계가 강제**한다.
- Claude(설계·검증) ↔ Codex(구현) **핸드오프를 오케스트레이션**한다.
- 검증(HTTP 스모크 등)을 **재현 가능·안전한 CLI**로 만든다.

**비목표(의도적 제외)**
- **완전 무인 커밋·push 금지.** 명시 요청 시에만. `REVIEW→커밋`은 사람 게이트.
- 하이리스크 작업의 무인 진행 금지.
- **외부 쓰기(GitHub Issue 코멘트 등) 자동 호출 금지** — 사람 실행/승인 대상.

## 2. 신뢰 모델

강제 장치(`task set` 쓰기 제한, TTY 검사, lint)는 **"협조적이지만 실수할 수 있는 에이전트"를 위한 가드레일**이지 악의적 우회를 막는 보안 경계가 아니다. 직접 파일 편집·PTY 할당으로 우회 가능하며 이를 막는 것은 목표가 아니다.

- **최종 방어선은 사람 커밋 게이트**다: 커밋 전 `git diff TASK.md`를 사람이 확인한다.
- 진짜 승인 무결성이 필요해지면 **인증된 외부 게이트**(GitHub PR 승인, 서명 커밋)를 도입한다 — CLI 자체로는 해결하지 않는다.

## 3. 단일 소스

**`TASK.md`가 단일 소스다.** 최상단 YAML front matter = 기계-판독 상태, 그 아래 프로즈 = 사람용 상세. Git으로 그대로 공유한다. 동시에 하나의 Active Task만 유지한다.

**front matter는 정확히 하나여야 한다.** 파싱은 non-greedy라 첫 블록만 읽고 나머지를 전부 본문으로 넘기며 섹션 검사도 첫 매치만 본다 — 그래서 문서가 통째로 복제되면 복제분이 아무 검사도 받지 않고 lint가 통과했다. 실제로 구현자가 JS `String.replace`로 본문을 갈아끼우다 치환 문자열의 `` $` ``(매치 앞부분 전체로 치환되는 특수 토큰)를 흘려 문서가 복제된 사고가 있었고, lint는 그 손상을 잡지 못했다. 지금은 본문에서 front matter 전용 키가 열 0에 나오거나 온전한 `---` 뒤에 YAML 키가 오면 파싱 자체를 거부한다. 코드 펜스 안은 검사하지 않고(예시 YAML 오탐 방지), 본문의 `---` 수평선은 다음 줄이 키가 아닌 한 통과한다.

### 3.1 front matter 스키마

| 필드 | 형식 | lint |
|---|---|---|
| `id` | string, IDLE이면 `null` | 활성 상태 필수 |
| `status` | enum(§4) | 항상 |
| `objective` | 1줄 string | 활성 상태 필수 |
| `requester` | string | 활성 상태 필수 |
| `roles.designer` | string | **DESIGN부터 필수** |
| `roles.{implementer,reviewer}` | string | **READY부터 필수** |
| `branch` | string | 항상 |
| `designCheckpoint` | commit SHA 또는 문자열 | READY+ 필수. REVIEW→READY 시 재입력 강제 |
| `issue` | number 또는 `null` | 선택 |
| `highRisk` | bool(기본 false) | 항상. **true면 `roles.designer`에 항상, `roles.reviewer`에는 READY부터 `Opus` 포함 필수** |
| `verification` | 객체(§5) 또는 `null` | REVIEW부터 객체 필수(`status:null` 허용) |
| `blocked` | 객체 또는 `null` | BLOCKED일 때만 객체 |
| `closure` | 객체 또는 `null` | CANCELLED·SUPERSEDED일 때만 객체 |
| `updated` | ISO 8601 일시 | 항상 |
| 프로즈 섹션(요구사항·불변식·영향 범위·설계 = READY↑, Review 불릿 다음 담당자·다음 행동 = REVIEW↑) | 리스트/서술 | 상태별 non-empty |

> **non-empty 판정**: lint는 `없음`·`미정`·`TODO`·`-`(단독), 그리고 항목이 이들뿐인 목록을 **빈 것으로 간주**한다.

### 3.2 프로즈 본문 캐노니컬 섹션

```markdown
## Active Task
### 요구사항과 완료 조건
### 필독 문서와 불변식
### 영향 범위
### 확정된 설계와 미확정 사항
### 구현 및 설계 차이
### 검증 결과
### Review와 다음 행동
- **다음 담당자**:   ← front matter에 없어 불릿 유지, lint 필수(REVIEW+)
- **다음 행동**:
```

## 4. 상태머신

```
IDLE → DESIGN → READY → IMPLEMENTING → REVIEW → DONE
                  ↑           ↑          ││
            READY ←───────────┘          ││ REVIEW→IMPLEMENTING (구현 보완 루프백)
                  └───────────────────────┘ REVIEW→READY (설계 변경 후 재핸드오프)

활성상태(4종) ⇄ BLOCKED            : task block "<사유>" / task unblock
활성·BLOCKED → CANCELLED           : task cancel "<사유>"
활성·BLOCKED → SUPERSEDED          : task supersede <대체id> "<사유>"
종결상태 → IDLE                    : task reset (§6 초기화 거부 규칙 통과 시)
```

- 허용 전환만 CLI가 통과시킨다. `DESIGN→DONE` 등 건너뜀 거부.
- **REVIEW 루프백 시 verification 원자 초기화**: `REVIEW→IMPLEMENTING`·`REVIEW→READY`는 verification을 리셋한다(이전 `PASSED`로 무검증 DONE 직행 차단).
- **`REVIEW→READY`는 `--design-checkpoint` 재입력 강제**(설계가 변했으므로).
- `DONE`은 "코드 작성 완료"가 아니라 "구현+정합성+검증 완료".

## 5. verification 블록 · DONE 게이트

- 필드: `status`(PASSED|FAILED|PARTIAL|null), `failedCount`(int), `partialApproved`(bool), `approvedBy`(str|null), `approvedAt`(ISO|null), `updated`(ISO|null), `evidence`(객체|null).
- **`evidence`(선택)**: `task record-verification --evidence "<명령>"`을 주면 그 명령을 **실제로 실행**해 `{command, exitCode, outputSha256, at}`을 남긴다. 문자열만 받아 적으면 "테스트를 돌렸다"는 자기 신고에 지나지 않기 때문이다. lint는 **`PASSED`인데 `exitCode ≠ 0`인 모순을 거부**한다. 구버전 `TASK.md` 호환을 위해 필드 자체는 선택이다.
- **쓰기 경로 제한**: `verification.*`는 `task set`으로 직접 수정 불가. 경로는 3개뿐 — `task record-verification`(수동 기록), `task verify`(자동 하니스, Tier 2), `task approve-partial`(승인 3필드).
- `task record-verification --status <S> --failed-count <N>`: **REVIEW에서만 허용**, 승인 3필드 항상 초기화.
- `task approve-partial`: `stdin.isTTY && stdout.isTTY`를 검사해 **비대화형 실행 거부**. TTY 검사는 자동 실행 방지 장치일 뿐 사람 신원 보증이 아니다.
- **`REVIEW→DONE` 허용 조건**:
  ```
  (status == PASSED && failedCount == 0)
  || (status == PARTIAL && failedCount == 0 && partialApproved == true)
  ```

## 6. closure · reset 거부 규칙

- 취소·대체의 사유·행선지를 초기화 전에 기계-판독 형태로 보존(`closure.{type,reason,replacementId,archiveRef,at}`).
- `task archive <ref>`: 종결 상태에서 `closure.archiveRef` 설정. 단순 존재가 아니라 **현재 Task·closure 내용이 대상에 실제 보존됐는지 검증**(`commit:<sha>` / `docs:<path>`의 `<!-- TASK-ARCHIVE ... -->` 블록). `issue:#N`은 `task issue-sync` 경유만.
- **`task reset`(종결→IDLE)**: `DONE`은 커밋되어 clean일 때만; `CANCELLED·SUPERSEDED`는 (a) `closure.archiveRef` 존재 또는 (b) 커밋되어 clean일 때만. 이력이 어디에도 없는 채 지워지는 것을 차단.

## 7. 명령 표면 (`duet-task`)

런타임: Node.js ≥ 18. front matter 파싱·재작성은 `yaml`(eemeli) Document API(주석·키 순서 보존).

| 명령 | 책임 |
|---|---|
| `task show` / `task lint` | 상태 출력 / 스키마·필수필드 검사 |
| `task start <id> --objective --requester --designer` | IDLE→DESIGN 신규 시작(본문을 스켈레톤으로 교체) |
| `task set status=<S> [--design-checkpoint <v>]` | 전환 순서 강제 + DONE 조건 + 루프백 초기화 |
| `task set <k>=<v> ...` | 일반 필드 갱신(`verification/blocked/closure` 직접 쓰기 금지) |
| `task block "<사유>"` / `task unblock` | BLOCKED 진입/복귀 |
| `task cancel "<사유>"` / `task supersede <대체id> "<사유>"` | 종결(closure 기록) |
| `task reset` | 종결→IDLE(§6 규칙) |
| `task record-verification --status <S> --failed-count <N>` | 검증 결과 수동 기록(REVIEW 전용) |
| `task archive <ref>` | closure.archiveRef 설정 |
| `task approve-partial` | PARTIAL→DONE 사람 승인(TTY) |
| `task issue-sync` | Issue 코멘트(수동 전용, 외부 쓰기). §7.1 |

- **lint 밖**: 전환 이력 검증(사람 직접 편집은 커밋 전 사람 리뷰가 최종 방어선). **대상 CI는 `task lint`만 실행**한다(엔진 테스트는 duetcode 저장소에서 돈다).

### 7.1 `issue-sync` — 유일한 비가역 외부 쓰기

다른 명령은 "명령 수행 → lint → save" 순서를 공유하지만, 이 명령만 **lint를 gh 호출보다 앞에 둔다.** 공통 lint는 게시 뒤에 돌기 때문에, 무효한 상태가 이미 Issue에 올라간 다음에야 걸린다 — 그 게시는 되돌릴 수 없다.

코멘트는 매번 새로 달지 않고 **본문 첫 줄의 마커 `<!-- duetcode:issue-sync <task-id> -->`로 기존 것을 찾아 갱신(upsert)** 한다. 게시에 성공하고 `save()`가 실패하면 `closure.archiveRef`가 남지 않아 재실행하게 되는데, 그때 코멘트가 또 달리면 Issue가 같은 Task로 도배되기 때문이다. 파생 규칙 둘:

- 기존 코멘트 **목록 조회에 실패하면 게시하지 않는다**(fail-closed). 중복 여부를 확인하지 못한 채 올리면 중복을 막을 방법이 없다.
- 같은 Task의 마커가 **2개 이상이면 거부**하고 사람에게 넘긴다. 임의로 하나만 갱신하면 나머지가 낡은 채 남아 Issue가 서로 모순된 내용을 갖는다.

## 8. 핸드오프 오케스트레이션 (`duet-handoff`)

`TASK.md`를 공유 메모리, `duet-task`를 상태머신, CLI를 전송 계층으로 둔다. Claude가 오케스트레이터가 되어 Codex를 단발 호출하고 결과를 회수하는 단방향 위임.

- `npm run handoff`가 READY·highRisk·lock을 검사하고 `READY→IMPLEMENTING` 전환 성공을 실측한 뒤, 저장소 루트 cwd에서 `codex exec --json`을 한 번 spawn한다. 프롬프트는 `build-prompt.js`가 만들어 stdin으로 전달.
- 신규: `codex exec --json -c 'sandbox_mode="workspace-write"' -`. 재개: `codex exec resume ... <SESSION_ID> -`. `-o` 파일 출력은 쓰지 않는다(강제종료 시 원문 잔존 방지) — 모델 최종 메시지는 정화된 `events.jsonl`에만 남는다. 재개 session id는 최초 JSONL `thread.started.thread_id`만 저장해 명시 사용(`--last` 미사용).
- **성공 판정은 exit code 하나로 하지 않는다**: 종료 후 front matter status(REVIEW 도달)·`task lint`·`git status --porcelain`을 함께 실측. **REVIEW 미도달은 exit 0이어도 실패.**
- 동시 실행 제어는 원자 lock, `(id,status,updated)` idempotency key. timeout(기본 30분)·전송 실패·helper 부재(무산출 exit 0)는 성공으로 해석하지 않고 자동 재시도·DONE 전환·rollback 없이 정지.
- Codex에 주는 프롬프트는 commit/push/release·DONE 전환·issue-sync·record-verification·front matter 직접 편집·Task 범위 밖 변경을 **금지**하고, 본문 편집은 문자열 치환 API 대신 해당 절 직접 수정으로 하라고 지시한다(§3의 `` $` `` 사고).
- **transport·timeout 판정은 실측보다 앞서지만, 실측 사실을 판정문에 덧붙인다.** helper 기동 실패는 "작업이 어떤 환경에서 돌았는지 보증할 수 없다"는 뜻이라 exit 4가 맞다. 다만 그 코드가 "아무 일도 없었다"로 읽혀 그대로 재실행하면 이미 끝난 작업을 중복 수행한다. 그래서 REVIEW 도달 여부·작업 트리 변경 건수를 reason에 남긴다 — 판정은 보수적으로, 사람의 다음 판단은 사실에 근거하도록.
- `Codex` 실행 파일은 `HANDOFF_CODEX_CMD` env(JSON 배열 또는 문자열)로 교체 가능. 상태는 `HANDOFF_STATE_DIR`(기본 `<repo-root>/.duet/state/`, 커밋 제외).
- **로그는 흘려보내되, 안전을 증명할 수 있는 지점까지만 방출한다.** 마스킹은 완전한 문맥에서 해야 경계 누출이 없으므로 예전에는 종료 시 한 번만 기록했는데, 그러면 30분짜리 run의 `events.jsonl`이 끝날 때까지 비어 있고 강제종료 시 전량 유실됐다. 지금은 ① 줄 경계에서만 자르고(한 줄짜리 토큰 보호) ② env 유래 시크릿 중 가장 긴 것보다 넓은 tail을 남기며(멀티라인 시크릿 보호) ③ 닫히지 않은 PEM 블록은 닫힐 때까지 들고 있다(길이 상한이 없는 유일한 패턴). 이 셋을 만족하는 앞부분만 내보낸다.
- **run 산출물은 보존 개수를 넘으면 오래된 것부터 지운다**(`HANDOFF_RUN_RETENTION`, 기본 20). 프롬프트·모델 출력 전문이 남는 디렉터리라 무제한 누적은 용량보다 잔존 자체가 위험이다. 삭제 건수는 새 run의 `metadata.json`에 남겨 조용히 사라지지 않게 한다.

## 9. 검증 하니스 `task verify` (Tier 2 — 미구현)

비파괴 HTTP 스모크를 CLI로 고정할 예정. 허용 프로파일 화이트리스트(운영 프로파일 거부), 비파괴 원칙(read-only GET·no-op·검증-실패 프로빙), 최대 실행 시간, 소유권 확인 후 프로세스 종료, 실패 시 cleanup. 계정·데이터는 `.duet/verify.json`(커밋 제외). 설정 누락은 해당 항목만 `PARTIAL`.

## 10. 사람 게이트 (자동화 금지 지점)

1. **커밋·push·release** — 명시 요청 시에만. 파이프라인은 `REVIEW`에서 정지.
2. **하이리스크 작업** — Opus 앞뒤 게이트(lint roles + 핸드오프 게이트).
3. **공개 API·DB 스키마·보안 정책 변경** — 구현 전 사용자 확인.
4. **비밀값·프로파일 변경** — 자동화 제외.
5. **외부 쓰기(issue-sync 등)** — 사람 실행/승인.
6. **`PARTIAL` 검증으로 DONE** — `task approve-partial`로만.

## 11. 파일 구조 (설치 후 대상 저장소)

```text
TASK.md                              # Active Task 상태(단일 소스)
.duet/state/                         # 핸드오프 런타임 상태(gitignore)
.duet/verify.json                    # 검증 하니스 로컬 설정(gitignore, Tier 2)
.github/workflows/task-lint.yml      # CI: npm run task:lint
docs/duetcode-collaboration-protocol.md
package.json                         # duetcode devDep + task/task:lint/handoff 스크립트
node_modules/duetcode/               # 엔진 실체(gitignore) — 대상 저장소에 사본이 생기지 않는다
```

엔진은 대상 저장소에 복사되지 않는다. 어떤 버전을 쓰는지는 lockfile에 커밋되고, 갱신은 `npm install`이다.
