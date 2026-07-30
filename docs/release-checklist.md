# 배포 전 체크리스트 — duetcode 첫 공개

> 이 문서는 `cc-symphony` → `duetcode` 개명·신규 저장소 결정이 내려진 세션의 **인수인계 기록**이다.
> 결정의 *결과*는 코드에 이미 반영되어 있으므로, 여기에는 **코드만 봐서는 알 수 없는 근거**와 **아직 하지 않은 일**만 적는다.
>
> 관련 문서: 보안 검토는 [public-release-readiness.md](public-release-readiness.md), 다음 리팩터링 계획은 [engine-externalization.md](engine-externalization.md).

## 1. 게시 — **완료**

`https://github.com/sdcomms4227/duetcode` public, 최신 릴리스 **`v0.4.1`**.

> 이 절의 버전은 **손으로 갱신한다.** 자동 동기화(§8) 대상은 설치가 실제로 해석하는 참조뿐이고, 아래 경위 서술의 버전은 기록이라 치환하면 거짓이 된다.

- [x] author 이메일 noreply 확인
- [x] public 저장소 생성 + push
- [x] Secret scanning — **기본 활성이었다**. public 저장소는 켤 필요가 없었고, 아래 push 차단이 그 증거다
- [x] Push protection — 동일하게 기본 활성
- [x] 구 `cc-symphony` archive(§4)
- [x] 실설치 스모크 테스트 — 당시 `github:sdcomms4227/duetcode#v0.1.1`로 검증했다

> **`gh` 활성 계정 주의.** 이 머신에는 `sdcomms4227`과 `mwlee-showtech`가 함께 로그인되어 있고, 작업 중 **활성 계정이 두 번 후자로 되돌아갔다**(두 번째는 push가 403). remote URL에 사용자를 박아 두었지만(`https://sdcomms4227@github.com/...`), push 전에 `gh auth status`로 확인하는 편이 안전하다.

### 켜지 않기로 한 것

`secret_scanning_non_provider_patterns`는 **일부러 끈 채로 둔다.** 이 저장소는 `redactText`가 가려낼 패턴을 총망라한 픽스처 덩어리라(`alpha-secret`, `s3cret`, `password=` 등), 켜면 오탐이 상시 발생한다. 그건 아래에서 경계하는 **경보 둔감화**를 그대로 만든다.

### 시크릿 스캐너 오탐 대응 방침 — **실제로 발생했고, 방침대로 처리했다**

예측대로 첫 push가 **GH013 push protection**으로 거부됐다. 걸린 것은 `engine/handoff/test/redaction.test.js:14`의 Slack 토큰 픽스처 하나였다(`xoxb-` + 숫자열). 저장소 생성은 성공했고 push만 막힌 상태였다.

> **방침: 예외 처리(unblock URL)로 무시하지 말고, 픽스처를 더 명백한 가짜 값으로 바꾼다.**
> 이유: 예외 목록이 길어질수록 진짜 경보에 둔감해진다. 그게 픽스처 노출보다 큰 위험이다.

처리 방법은 **같은 파일이 이미 쓰던 기법**을 따랐다 — 리터럴을 소스에 두지 않고 런타임에 조립한다:

```js
// before: Slack 토큰 형식(xoxb 접두사 + 숫자·영문 40여 자)이 한 줄짜리 리터럴로 있었다
// after:
'xoxb-' + '1'.repeat(10) + '-' + '2'.repeat(10) + '-' + 'x'.repeat(24)
```

> ⚠️ **이 문서에도 옛 리터럴을 적지 말 것.** 실제로 이 경위를 기록하면서 "before:" 주석에 옛 값을 그대로 인용했다가 **같은 탐지기에 다시 걸렸다.** 탐지기는 소스든 문서든 형식만 본다.

바로 위 두 줄(`'ASIA' + 'B'.repeat(16)`, `'AIza' + 'A'.repeat(35)`)이 이미 이 방식이라 통과했던 것이다. AWS 키(`AKIAIOSFODNN7EXAMPLE`)와 JWT는 리터럴이지만 GitHub이 공식 예시로 인지해 걸리지 않았다.

**문제는 그 값이 최초 커밋(구 `79edbc1`)에 있었다는 점이다.** push protection은 push되는 모든 커밋을 검사하므로 새 커밋으로 고쳐도 소용없다. `git filter-branch --tree-filter`로 이력 전체를 치환했고, **아직 push 전이라 비용이 없었다** — 이것이 push 전에 처리해야 했던 이유다. 백업 ref(`refs/original/*`)까지 지우고 `gc`한 뒤 `git log -p --all`에서 리터럴 0건을 확인했다.

> **앞으로 redaction 테스트에 픽스처를 추가할 때는 반드시 런타임 조립 방식을 쓴다.** 리터럴로 넣으면 다음 push에서 같은 일이 반복되고, 그때는 이력 재작성 비용이 훨씬 커진다.

**이 규칙은 이제 자동으로 강제된다** — `npm run lint:secrets`(`scripts/check-secret-literals.js`)가 저장소 전체의 텍스트 파일에서 자격증명 **형태의 리터럴**을 찾아 exit 1로 막고, `scripts/test/secret-literals.test.js`가 `npm test`에서 같은 검사를 돌린다. 검사가 "패턴이 하나도 안 맞아서" 조용히 통과하는 일이 없도록, 테스트는 종류별 위반 샘플을 실제로 잡는지도 함께 확인한다.

허용 목록(`ALLOWED_LITERALS`)에는 GitHub이 공식 예시로 인지해 **막지 않는** 값만 넣는다. 현재 항목은 AWS 예시 키 하나뿐이고, 테스트가 그 목록의 크기를 고정한다 — 목록이 커지면 린트가 무력해지기 때문이다. 근거가 없으면 허용하지 말고 런타임 조립으로 바꾼다. 이 린트는 형식만 보므로 **보안 경계가 아니다.** 목적은 하나다: 다음 push가 이력 재작성으로 이어지지 않게 한다.

### v0.1.0 → v0.1.1 — 스모크 테스트가 잡은 배포 결함

게시 직후 실설치 스모크 테스트에서 **문서 3개 중 1개만 생성되는** 결함이 드러났다.

원인은 `package.json`의 `files`에 `docs`가 없어 **배포본에 문서가 실리지 않은** 것이었다. `collaboration-protocol.md`는 `templates/`에서 오므로 정상이었고, `pipeline-design.md`·`pipeline-workflow-example.md`만 빠졌다. 게다가 `install.js`가 `if (fs.existsSync(...))`로 원본 부재를 **조용히 건너뛰어** 설치가 그대로 "완료"로 끝났다.

두 가지를 고쳤다:

1. `files`에 필요한 문서 두 개를 명시(디렉터리 통째로가 아니라 — 내부 체크리스트까지 배포할 이유가 없다)
2. 원본이 없으면 **예외를 던진다**. 조용한 누락이 이 결함을 게시까지 통과시킨 실제 원인이다

**교훈: 이 결함은 저장소 안의 어떤 테스트로도 잡히지 않았다.** 클론에서 실행하면 `docs/`가 항상 존재하기 때문이다. 오직 `npm pack` 결과를 실제로 설치해야 드러난다. 회귀는 `scripts/test/package-meta.test.js`가 `install.js`의 `PACKAGE_SOURCES`와 `files`를 대조하는 방식으로 고정했으며, **배포 형태를 바꿀 때는 반드시 실설치 스모크 테스트를 돌린다.**

### v0.1.3 → v0.2.0 — 첫 breaking 릴리스, 그리고 파이프라인이 자기 사고로 배운 것

**minor로 올린 이유**: `task lint`에 규칙이 하나 늘어 기존 `TASK.md`를 깨뜨릴 수 있다. 본문 열 0에 front matter와 같은 이름의 키(`status:`, `branch:` 등)를 쓰던 저장소는 이제 거부된다. 회피는 간단하다 — 들여쓰거나 코드 펜스로 감싼다. README "Versioning"이 밝힌 대로 pre-`1.0.0`에서는 breaking 변경이 minor에 실린다.

**규칙이 생긴 경위가 이 기록의 핵심이다.** 위임 실행에서 `TASK.md`가 통째로 복제되는 손상이 났다. 처음엔 `duet-task` 결함으로 의심했지만 아니었다 — 구현자가 본문을 JS `String.replace`로 갈아끼웠고, 새 본문에 들어 있던 `` $` ``가 치환 문자열의 특수 토큰(매치 앞부분 전체)으로 해석된 것이 원인이었다. 엔진 밖의 사고다.

그럼에도 **엔진에 남는 문제가 둘 있었다**:

1. **손상된 문서가 lint를 통과했다.** 파싱 정규식이 non-greedy라 첫 front matter만 읽고 나머지를 전부 본문으로 넘기며, 섹션 검사도 `indexOf`로 첫 매치만 본다. 복제분은 어떤 검사도 받지 않았다. 재현해 보면 `---`가 4줄인 문서가 `lint exit 0`으로 통과한다.
2. **구현자 프롬프트에 안전한 본문 편집 방법이 없었다.** 금지 목록은 있었지만 "그래서 어떻게 고치라는 것인가"가 없었다.

> **탐지 규칙을 처음 짤 때 실제 사고 형태를 놓쳤다.** "줄머리 `---` + YAML 키"만 검사했는데, `` $` `` 치환은 여는 `---`가 앞 줄 끝에 붙어버려(`- 새 요구사항 ---`) 그 조건에 걸리지 않는다. **재현 테스트를 먼저 쓴 덕에 규칙이 틀렸다는 걸 즉시 알았다.** 손상 형태를 상상해서 규칙을 만들면 안 되고, 실제 손상을 만들어 놓고 규칙을 맞춰야 한다. 최종 규칙은 "front matter 전용 키가 열 0에 등장"을 함께 본다 — 구분자가 깨져도 키는 열 0에 남기 때문이다.

**같은 릴리스에서 정리한 다른 계열**: 비가역·무음 경로가 검증보다 앞서던 자리들이다. `issue-sync`가 lint보다 먼저 GitHub에 썼고(무효 상태 게시 + 재시도 시 중복 코멘트), `--evidence`는 값이 없으면 증거 없는 `PASSED`를 조용히 기록했으며, `releaseLock`의 예외가 `finally`에서 새어 나가 원래 실패 원인을 덮었다.

**시크릿 스캐너**: 이번엔 걸리지 않았다. redaction 테스트에 픽스처를 추가하면서 §시크릿 스캐너 방침대로 런타임 조립(`'sk-' + 'a'.repeat(40)`)을 썼기 때문이다. 규칙이 실제로 작동한 첫 사례다.

### v0.2.0 → v0.2.1 — 저장소 자신에게는 없던 CI, 그리고 두 엔진의 경로 규칙 통일

**patch로 올린 이유**: 공개 계약(`EXIT_CODES`, CLI 인터페이스, `TASK.md` 스키마) 변경이 없다. `duet-task`의 상태 파일 탐색은 넓어지기만 했다 — `TASK_STATE_FILE` → cwd → 저장소 루트 순이고 cwd가 루트보다 우선하므로, 지금까지 성공하던 호출의 결과는 하나도 바뀌지 않는다.

**세 가지 모두 "감시자가 없던 자리"였다.**

1. **이 저장소에 CI가 없었다.** 대상 저장소용 `templates/task-lint.yml`은 배포하면서 정작 duetcode 자신은 push/PR에서 아무것도 돌지 않았다. Node 버전 간 러너 동작 차이(§5 말미)를 문서로 경계하는 프로젝트인데 그 회귀를 잡을 매트릭스가 없었다. `.github/workflows/ci.yml`이 ubuntu × 18·20·22·24와 windows × 20·22로 `npm test`를, 별도 job으로 `version:check`를 돌린다. Windows를 넣은 이유는 `taskkill` 프로세스 트리 종료와 `LOCALAPPDATA` codex 런처 탐색이 그 플랫폼에서만 실행되기 때문이다.

2. **중단 요청 파일을 지우는 주체가 없었다.** `consumeAbortRequest`는 `runId`가 다르면 `false`만 돌려주고 파일을 남긴다. 늦게 도착한 중단 요청(대상 run이 이미 끝난 경우)은 `.duet/state/abort`에 영구히 남아, 이후 모든 run이 250ms마다 읽기만 하는 쓰레기가 됐다. 새 run을 만드는 시점의 abort는 **정의상 stale이다** — dispatch는 lock을 쥔 뒤에 run을 만들므로 그때 다른 run을 겨냥한 유효한 요청이 존재할 수 없다. `createRunDirectory`가 걷어내고, 걷어냈다는 사실은 `metadata.json`의 `staleAbortCleared`에 남긴다(`prunedRuns`와 같은 원칙 — 조용히 사라지게 두지 않는다).

3. **두 엔진이 저장소 루트를 각자 계산했다.** handoff에만 해석기가 있었고 task CLI는 `TASK.md`를 cwd 기준으로 열었다. 그래서 같은 저장소의 하위 디렉터리에서 `duet-handoff`는 동작하고 `duet-task`는 "파일 없음"으로 죽었다. 해석기를 `engine/task/lib.js`로 옮기고 handoff가 import한다(의존 방향은 기존과 같은 handoff → task). 규칙이 두 벌이면 같은 명령이 서로 다른 `TASK.md`를 건드릴 수 있다.

> **탐색 순서에서 cwd를 루트보다 앞에 둔 것이 호환성의 핵심이다.** 루트를 먼저 보게 하면 하위 디렉터리에 자기 `TASK.md`를 두고 쓰던 사용자의 동작이 조용히 바뀐다. 순수한 확장이 되도록 폴백을 뒤에 붙였고, 셋 다 없을 때만 오류를 낸다 — 그 오류는 찾아본 경로와 `TASK_STATE_FILE` 지정 방법을 함께 말한다.

### v0.2.1 → v0.2.2 — 문서가 약속한 것을 코드가 지키지 않던 자리들

**patch로 올린 이유**: 공개 계약 변경이 없다. `duet-task`의 인자 없는 호출만 exit 1에서 `show`로 바뀌는데, 이는 `/duetcode:task`가 이미 문서화하고 있던 동작이라 계약 위반이 아니라 **계약 이행**이다. 오타는 빈 문자열이 아니므로 여전히 거부된다.

**설치기가 자기 원칙을 지키지 않았다.** `install.js`는 SHARE.md preflight에 *"실패해도 대상 저장소를 전혀 건드리지 않는다"*고 원칙을 적어 뒀는데, 정작 배포본 원본 검사만 그 밖에 있었다. 문서 존재 검사가 마지막 단계라 `package.json`·`TASK.md`·CI·`.gitignore`가 이미 쓰인 뒤에 실패했다 — v0.1.0의 `files` 누락 같은 배포 결함이 재발하면 대상이 어중간한 상태로 남는다. `PACKAGE_SOURCES` 전체 존재 검사는 순수 검사라 쓰기 이전으로 옮겼다.

같은 파일에서 두 가지를 더 고쳤다. 대상 파일 쓰기를 **temp→rename**으로 바꿨다 — 이 저장소는 `TASK.md`(`save`)와 핸드오프 상태(`writeJson`)를 이미 그렇게 다루는데 정작 **남의 저장소 `package.json`만 직접 덮어쓰고** 있었다. 그리고 추가할 것이 없으면 `package.json`을 쓰지 않는다. 내용 비교가 아니라 "추가했는가"로 판정하는 것이 핵심인데, 대상이 4-space나 탭을 쓰면 내용이 같아도 직렬화 결과가 달라 매번 재포맷 diff가 나기 때문이다.

**placeholder 판정이 두 벌이었고, 주석이 그 사실을 감췄다.** `build-prompt.js`는 *"task validate의 meaningful()과 동일 판정"*이라고 적혀 있었지만 달랐다 — `meaningful()`은 불릿만 값으로 인정하는데 `sectionIsPlaceholder`는 아무 줄이나 인정해서, 불릿 없는 산문 섹션을 build-prompt는 통과시키고 lint는 거부했다.

> **뚫리는 구멍이 아니어도 고칠 이유가 된다.** 신규 위임은 READY 도달에 lint가 걸리고 resume 경로도 preflight lint를 돌아서, 느슨한 쪽이 실제 게이트가 되는 일은 없었다. 문제는 규칙이 두 벌이라 **한쪽만 고치면 조용히 갈린다**는 점이고, "동일 판정"이라는 주석이 다음 사람에게 확인할 필요가 없다고 말하고 있었다는 점이다. §3.1 저장소 루트 해석(v0.2.1)과 같은 계열이다 — 규칙은 한 곳에만 둔다.

**운영 스킬이 `--evidence`를 빠뜨리고 있었다.** v0.2.0에서 "테스트를 돌렸다"는 자기 신고를 막으려고 넣은 플래그인데 `skills/pipeline/SKILL.md`의 명령 목록에 없어서, 스킬만 보고 따르는 에이전트는 증거 없이 `PASSED`를 기록하게 된다. 게이트를 만들어 놓고 **운영 문서에 적지 않으면 그 게이트는 없는 것과 같다.**

**문서 드리프트 두 건도 같이 걷어냈다.** README 환경변수 표가 `DUET_REPO_ROOT`를 "`duet-handoff` 전용"이라고 적고 있었는데 v0.2.1의 루트 해석 통일로 사실이 아니게 됐다(변경을 낸 그 릴리스에서 놓쳤다). `docs/pipeline-design.md` §5는 verification 쓰기 경로를 "3개뿐"이라며 미구현인 `task verify`를 함께 세고 있었다 — §9가 Tier 2 미구현이라고 밝히지만 그 줄만 읽으면 존재하는 명령으로 읽히고, **이 문서는 대상 저장소로 배포된다.** (이후 `task verify`를 실제로 구현해 어긋남을 반대 방향에서 해소했다 — §7 참조.)

## 2. 왜 `duetcode`인가 — 재론 방지용 기록

이름 후보를 npm에서 실측한 결과다. 나중에 "agentmux가 더 낫지 않았나"가 다시 나오면 이 표를 보면 된다.

| 후보 | npm | 판정 |
|---|---|---|
| `agentmux` | **선점됨** (`1.0.0`) | **탈락.** 설명이 *"orchestrates multiple Claude Code instances via tmux sessions"* — 이름뿐 아니라 **제품 정체성이 겹친다** |
| `baton` | 선점(`0.0.0`, 스쿼팅성) | 의미는 최적이나 npm 이름이 막힘 |
| `tutti` | 선점(`0.0.10`) | "전원 합주"=병렬인데 이 구조는 직렬이라 부정확 |
| `relaycode` | 선점(`1.1.6`, 활성) | 탈락 |
| **`duetcode`** | **미등록** | **채택.** CLI `duet`도 비어 있음 |

### `agentmux`류를 피한 더 중요한 이유

**이 프로젝트는 에이전트를 다중화하지 않는다.** 실측 근거:

- 저장소 전체에 `tmux` 문자열 **0건**
- 워커 실행은 `engine/handoff/dispatch.js`의 `spawn()` — **Codex CLI 단일 자식 프로세스**
- `acquireLock`/`releaseLock`이 오히려 **동시 실행을 배제**한다

즉 구조는 "N개 에이전트 병렬"이 아니라 **Claude ↔ Codex 2인 직렬 릴레이 + 사람 게이트**다. `duetcode`(듀엣 = 둘이 번갈아)가 이 구조를 정확히 서술한다. README 태그라인 *"A duet, not a swarm"*도 같은 이유다.

**⚠ 이름이 거짓이 되는 조건**: 세 번째 워커(Gemini 등)를 정식 지원하면 "duet"이 부정확해진다. 그 시점에 `baton`(인원수를 함축하지 않고, 지휘봉+바통 인계의 이중 의미) 재검토를 권한다. 지금 확장 계획이 없어서 `duetcode`로 갔다.

## 3. 이번에 확정된 명명 규약

| 항목 | 값 | 비고 |
|---|---|---|
| 플러그인·저장소명 | `duetcode` | `duet` 단독은 음악 앱과 섞여 기각 |
| 슬래시 커맨드 | `/duetcode:task`, `/duetcode:handoff` | |
| 로컬 상태 디렉터리 | `.duet/` | 구현 완료(`state/`, `verify.json`) |
| repo root 오버라이드 env | `DUET_REPO_ROOT` | 구현 완료 — 두 엔진 공통(해석기는 `engine/task/lib.js`, handoff가 import) |
| bin 이름 | `duet-task`, `duet-handoff`, `duet-init` | 구현 완료 |
| 초기 버전 | `0.1.0` | 신규 저장소이므로 초기화 (구 저장소는 `0.1.1`이었다). 현재 버전은 `package.json`이 단일 소스다 — 이 표에서 찾지 말 것 |

`HANDOFF_STATE_DIR`·`TASK_STATE_FILE`·`HANDOFF_CODEX_CMD`는 **일부러 개명하지 않았다.** 이미 동작 중인 공개 인터페이스라 바꾸면 기존 설치 대상에 breaking change다. 통일하고 싶으면 구 이름을 경고와 함께 한동안 인식하는 유예 기간이 필요하다.

## 4. 구 `cc-symphony` 저장소 처리

**삭제하지 말 것.** 개명(rename)이 아니라 신규 생성이므로 **GitHub 자동 리다이렉트가 없다.** archive + README 이관 안내가 유일한 연결고리다.

로컬 `C:\Project\cc-symphony`는 **개명 전 상태로 원상 복구**되어 있다(HEAD `8a0d7f5`, clean). 그쪽에는 duetcode 관련 변경이 하나도 남아 있지 않으니, 혼동하지 말고 이 저장소만 작업하면 된다.

구 저장소 README 상단에 붙일 안내 문안:

```markdown
> ⚠️ **이 저장소는 [duetcode](https://github.com/sdcomms4227/duetcode)로 이관되었습니다.**
> 개발은 그쪽에서 계속됩니다. 이 저장소는 기록 보존용으로 archive 되었습니다.
```

## 5. 검증 기준선 (개명 직후 실측)

회귀 판단의 기준점이다. 무언가 바꾼 뒤 이 숫자가 달라지면 개명이 아니라 그 변경이 원인이다.

```
task:lint      통과 (이 저장소에 TASK.md가 있을 때만)
task:test      50 / 50
handoff:test   72 / 72
scripts/test   22 / 22
```

> 이 저장소에서 `npm test` 하나로 전부 돈다(엔진 외부화 이후 자기설치 절차가 사라졌다).

> 개명 직후에는 22 / 49 / 7이었다. 러너 계약 3건씩과 부트스트랩 회귀가 더해졌고, 엔진 외부화로 설치기 테스트가 새 계약(엔진 미복사·duet-* 스크립트·잔재 보고)에 맞게 재작성되면서 16으로 정리됐다. 이후 `package-meta` 회귀 1건과 버전 동기화(§8) 5건이 더해져 22가 됐다.

재현 절차:

```bash
npm install && npm test
```

부트스트랩 경로까지 확인하려면 저장소 밖 스크래치 디렉터리를 대상으로 삼는다. 게시 전에는 `github:` 스펙을 쓸 수 없으므로 `file:`로 실제 해석 경로를 검증한다:

```bash
node scripts/install.js --target <scratch-dir>
cd <scratch-dir>
npm pkg set devDependencies.duetcode=file:/path/to/duetcode
npm install && npm run task:lint && npx duet-task --version
```

> 명령에 셸 glob이나 디렉터리 인자를 쓰지 말 것 — 셸·Node 버전마다 동작이 갈린다(실측: cmd.exe는 glob을 확장하지 않고 Node 자체 glob은 21+라 18·20은 `Could not find`로 exit 1; 디렉터리 인자는 18·20이 재귀 실행하지만 22는 `MODULE_NOT_FOUND`). 각 `test/run.js`를 호출하거나 파일을 명시한다.

## 6. 기존 설치 대상 마이그레이션 — 놓치기 쉬운 함정

개명으로 `install.js`가 만드는 **문서 파일명이 바뀌었다**:

```
docs/cc-symphony-collaboration-protocol.md   →  docs/duetcode-collaboration-protocol.md
docs/cc-symphony-pipeline-design.md          →  docs/duetcode-pipeline-design.md
docs/cc-symphony-pipeline-workflow-example.md→  docs/duetcode-pipeline-workflow-example.md
```

`ensureFileFromTemplate`는 **skip-if-exists**다. 따라서 기존 대상 저장소에 재설치하면 **구 파일이 남은 채 신 파일이 추가로 생성되어 6개가 공존**한다. 자동 삭제는 없다 — 사용자 문서를 지우는 것은 설치기의 권한이 아니다(`OBSOLETE_SCRIPTS`·`tools/` 잔재와 같은 정책).

다만 **탐지는 자동이다.** `install.js`의 `LEGACY_DOCS`가 구 파일명을 알고 있어, 남아 있으면 재설치 시 "신·구 파일이 공존합니다"로 보고한다. 정리는 여전히 대상 저장소에서 수동으로:

1. 보고된 구 `docs/cc-symphony-*.md` 3개 삭제
2. 그 문서를 참조하던 곳 링크 수정 — 대상의 `CLAUDE.md`/`AGENTS.md`, 그리고 대상 `TASK.md` 본문
3. `.gitignore`의 `# --- cc-symphony pipeline` 주석 블록 갱신

**이 파일명은 이제 테스트가 고정한다**(`scripts/test/install.test.js`). 세 건이 걸린다: 설치 산출물이 정확히 `INSTALLED_DOCS`의 이름들인지, 구 파일이 있을 때 보고하되 지우지 않는지, `LEGACY_DOCS`의 대체 대상이 실제 설치 파일인지. 앞으로 문서 파일명을 바꿀 때는 `INSTALLED_DOCS`와 `LEGACY_DOCS`를 **함께** 고쳐야 하며, 한쪽만 고치면 테스트가 실패한다. 예전처럼 눈으로 확인할 필요는 없다.

### 6.0 엔진 사본(`tools/`) 정리 — 외부화 이후

엔진은 더 이상 대상 저장소에 복사되지 않는다. 기존 설치 대상에서:

1. `npm i -D github:sdcomms4227/duetcode#<tag>` 후 `npx duet-init` 재실행
2. 보고되는 잔재를 손으로 정리 — `git rm -r tools/`, 그리고 불필요해진 `task:test`·`handoff:test` 스크립트 삭제
3. 진행 중인 핸드오프가 있으면 `tools/handoff/state/`를 `.duet/state/`로 먼저 옮긴다
4. `tools/task/verify.local.json`을 쓰고 있었다면 `.duet/verify.json`으로 옮긴다

`duet-init`은 사용자 파일을 지우지 않으므로 이 단계는 **수동**이다. 스크립트 값(`node tools/task/index.js` 등)은 자동 마이그레이션된다.

### 6.1 스크립트·`.gitignore`는 재설치로 갱신된다

구형 스크립트(`node tools/task/index.js` 등)와 `.gitignore` 신규 항목은 `npx duet-init` 재실행으로 자동 반영된다.

- `mergePackageJson`은 기존 값이 `LEGACY_SCRIPTS`의 알려진 구형 값과 정확히 일치할 때만 `duet-*`로 갱신한다(`migrate-script` 로그). 사용자가 손댄 스크립트는 건드리지 않고 충돌로 보고한다 — 그건 수동 조치 대상이다.
- `appendGitignore`는 항목 단위로 병합하므로, 일부만 있는 저장소에도 빠진 항목(`.duet/` 등)만 추가된다.
- 잔재(`task:test`·`handoff:test` 스크립트, `tools/` 디렉터리)는 **보고만 하고 지우지 않는다**(§6.0).

## 7. 다음 작업

### v0.4.0 → v0.4.1 — `finally` 하나로는 못 덮는 경로, 그리고 "고쳤다"가 사용자에게 닿지 않은 자리

**patch로 올린 이유**: 공개 계약(`EXIT_CODES`·CLI·`TASK.md` 스키마) 변경이 없다. `verify`의 `requires` 형식 검사가 새로 거부하는 입력이 생기지만, 그 입력은 지금까지도 정상 동작한 적이 없다(글자 단위로 순회해 엉뚱한 사유의 `SKIPPED`가 됐다).

**`task verify`가 오류를 출력하고도 종료하지 못했다.** 서버 준비 확인이 실패하면 `startServer`가 throw하는데, 정리 대상은 그 함수가 **돌려준** 핸들이라 `runVerify`의 `finally`는 `null`을 받는다. 서버는 포트를 문 채 살아남고, 자식의 stdio가 붙은 부모는 이벤트 루프가 비지 않아 CLI가 매달렸다(재현 exit=124 → 수정 후 exit=0).

> **§9는 "정리는 성공·실패·예외 모든 경로에서 실행된다(`finally`)"고 적고 있었고, 그 괄호가 함정이었다.** `finally`는 핸들을 **받은 뒤에만** 동작한다 — 서버가 뜨지 못한 경로는 애초에 그 밖이다. v0.3.3에서 `request()`의 무한 대기를 고치며 "검증이 조용히 멈춰 REVIEW를 붙잡는 것이 최악"이라고 적어 놓고, 같은 실패 양상이 한 층 위에 남아 있었다. 테스트도 두 층으로 나눴다: `kill(pid, 0)`으로 고아 여부를 직접 보는 것과, 사용자가 겪은 증상(CLI가 끝나지 않는다)을 경주로 보는 것. 수정을 되돌리면 테스트 러너 자체가 타임아웃까지 매달린다.

**`duet-init`이 커밋 없는 저장소에서 잘못된 브랜치를 적었다.** `git init` 직후가 정상 경로인데 `rev-parse --abbrev-ref HEAD`는 그때 실패한다. `git init -b develop` 저장소에 `branch: main`이 적혔고(단일 소스의 첫 값이 사실과 다르다), `execFileSync`가 자식 stderr를 흘려 성공한 출력 한가운데 `fatal:`이 찍혔다. `symbolic-ref --short HEAD`는 커밋 이전에도 답한다.

**v0.3.3의 액션 메이저 상향이 대상 저장소에 닿지 않았다.** 이 저장소 `ci.yml`만 v7로 올리고 `templates/task-lint.yml`은 v4로 두었다 — 없애려던 경고는 대상 저장소에서도 똑같이 뜬다. 설치기는 기존 워크플로를 덮어쓰지 않으므로 이 드리프트는 **신규 설치에서만 조용히 굳는다.** 두 파일의 메이저가 갈리면 실패하는 테스트를 넣었다.

> **이 릴리스의 세 건은 형태가 같다: 우리가 "고쳤다"고 적은 것이 실제로 닿는 범위를 좁게 확인했다.** 정리는 `finally`가 있으니 됐다고, 브랜치는 git이 알려주니 됐다고, 액션은 CI를 고쳤으니 됐다고 본 자리들이다. 셋 다 실설치 스모크와 소스 재독으로만 드러났다.

**남은 것**(고치지 않기로 판단한 것): `quoteForCmd`는 cmd의 `%VAR%` 확장을 무력화하지 않는다 — 인자에 리터럴 `%`가 있고 동명 환경변수가 있을 때만 문제이며, cmd에는 신뢰할 escape가 없다. `dispatch`의 `finally`는 모듈 `releaseLock`을 쓰고 신호 핸들러만 주입된 것을 쓴다 — 테스트 시임의 비대칭일 뿐 동작 차이는 없다.

### v0.3.3 → v0.4.0 — 핸드오프의 POSIX 트리 종료, 그리고 그것이 끌고 온 의무

**minor로 올린 이유**: 공개 계약(`EXIT_CODES`·CLI·`TASK.md` 스키마) 변경은 없지만, 핸드오프의 프로세스 수명과 신호 처리가 달라진다. pre-`1.0`에서 동작 변경은 minor에 싣는다.

codex를 POSIX에서 `detached`로 띄워 그룹 리더로 만들고, 세 종료 지점(timeout·abort·내부 실패)에서 그룹째 종료한다. 그전에는 `taskkill /T`가 있는 Windows에서만 트리가 정리됐고, POSIX에서는 codex가 실행한 도구·셸이 남아 저장소를 계속 수정할 수 있었다 — **abort가 "지금 당장 멈춰라"를 약속하면서 절반만 지키는 상태였다.**

> **`detached` 한 줄만 넣으면 고치려던 것보다 나빠진다.** `detached`는 codex를 자기 세션으로 분리해 **터미널의 Ctrl-C가 닿지 않게** 만든다. 그전에는 codex가 dispatch와 같은 포그라운드 그룹에 있어서 Ctrl-C가 둘을 함께 죽였다 — 우연이지만 안전했다. 핸들러 없이 detached만 넣으면 dispatch만 죽고 codex는 고아가 되어 계속 파일을 쓴다. 그래서 `SIGINT`/`SIGTERM`/`SIGHUP` 핸들러가 함께 온다: 트리 종료 → lock 해제 → `INCOMPLETE`(5). **둘은 한 묶음이며 한쪽만 넣어서는 안 된다.**

덤으로 기존 결함도 사라졌다. Node의 기본 신호 처리는 `finally`를 실행하지 않아 Ctrl-C로 끊으면 `dispatch.lock`이 남았다(다음 실행이 `lockIsStale`의 pid 생존 검사로 회수하긴 했다). 이제 즉시 해제된다.

**테스트를 두 층으로 나눈 것이 이 작업의 요점이다.** 이 저장소는 Windows에서 개발되는데 고치는 대상은 POSIX 경로다 — v0.3.1에서 정확히 그 이유로 반증당했다.

- 플랫폼 무관 단위 테스트: 실제 자식 프로세스를 띄워 정말 죽는지·lock을 푸는지·exit code가 5인지 확인한다. 가짜 객체는 "kill이 호출됐다"까지만 증명하므로 쓰지 않았다.
- POSIX E2E: 손자를 띄우는 stub에 `SIGINT`를 보내 marker mtime이 멈추는지로 트리 종료를 확인한다. Windows에서는 다른 프로세스에 `SIGINT`를 보낼 수 없어 skip된다.
- **CI 로그에서 그 skip된 테스트가 ubuntu에서 실제로 실행·통과했는지(`ok 40`)를 눈으로 확인했다.** 매트릭스가 green이어도 정작 그 변경을 검증하는 테스트가 모든 러너에서 skip이면 아무것도 확인하지 못한 것이다.

**남은 것**: 신호로 끊긴 run은 결과 판정을 만들 수 없어 `result.json`이 없다. run 디렉터리의 프롬프트·`events.jsonl`·`metadata.json`은 남으므로 사후 확인은 가능하다. 필요해지면 중단 사실을 담은 최소 산출물을 남기는 쪽을 검토한다.

### v0.3.2 → v0.3.3 — 조용히 멈추는 검증, 그리고 npm으로 설치한 codex

**`task verify`가 무한 대기할 수 있었다.** 서버가 헤더를 보낸 뒤 본문 중간에 소켓을 끊으면 `request()`의 Promise가 영원히 미결로 남았다. 실측한 이벤트 순서가 원인이다:

```
res.aborted → req.close → res.error(ECONNRESET) → res.close      ('end'는 오지 않는다)
```

코드는 `res`의 `'end'`와 `req`의 `'error'`만 듣고 있었다. `req`의 `'error'`는 **오지 않는다**. 게다가 `timeout` 옵션은 소켓 **비활성** 타임아웃이라 소켓이 파괴된 뒤에는 발동하지 않고, `maxDurationMs`는 검사 **사이**에만 확인되므로 둘 다 이 상황을 끊지 못했다. 실측으로 20초를 넘겨도 끝나지 않는 것을 확인했고, 고친 뒤에는 103ms에 `FAILED`로 끝난다.

> **크래시가 아니라 행이라는 점이 나쁘다.** 죽으면 사람이 알아채지만, 멈추면 REVIEW 게이트를 잡은 채 아무 출력도 없이 서 있다. 그래서 이제 (1) `res`의 `error`·`close`를 함께 받고 (2) 어떤 이벤트가 오든 예산을 넘기지 않는 독립 타이머를 둔다. 회귀 테스트 두 건은 각각 "본문 중간 끊김"과 "계속 흘러서 비활성 타임아웃이 발동하지 않는 응답"을 재현하고, **소요 시간 상한까지 단정한다** — 결과만 보면 행을 잡지 못한다.

**npm으로 설치한 codex로는 핸드오프를 쓸 수 없었다.** `parseCodexCommand`가 `codex.cmd`를 가리키면 `spawn EINVAL`로 죽었다(절대 경로 `.cmd`는 EINVAL, PATH의 맨이름은 ENOENT). v0.3.1에서 verify에 대해 고친 것과 **같은 문제**였는데 handoff는 `resolveSpawn`을 쓰지 않고 있었다 — 공유 규칙을 만들어 놓고 한쪽만 연결한 셈이다. 이제 둘 다 쓴다.

> 회귀 테스트는 codex stub을 `.cmd`로 감싸 dispatch가 실제로 그 경로를 타게 한다. **수정을 되돌려 테스트가 `spawn EINVAL`로 실패하는 것까지 확인했다** — 통과가 "다른 이유로 초록"이 아님을 확인하지 않으면 회귀 테스트라고 부를 수 없다.

**그 밖에**: CI 액션이 deprecated 상태였다(`actions/checkout@v4`·`setup-node@v4`가 Node 20을 대상으로 해 러너가 Node 24로 강제 실행). 실제 최신 메이저를 조회해 `checkout@v7`·`setup-node@v7`로 올렸다 — 감으로는 v5라고 답했을 뻔했다. §1의 "최신 릴리스" 표기도 갱신했다(`v0.2.2`에 멈춰 세 릴리스를 놓쳤다). 그 줄은 자동 동기화 대상이 아니라 손으로 고쳐야 하는 곳이다.

### v0.3.1 → v0.3.2 — CI가 "고쳤다"를 반증한 릴리스

**v0.3.1은 결함을 절반만 고친 채 게시됐다.** `terminateProcessTree`를 공유하면서 Windows 경로(`taskkill /T`)만 구현하고, POSIX에서는 `child.kill('SIGKILL')`로 직계 자식만 죽였다. Linux에서는 손자(`npm run dev` → node)가 살아남아 포트를 계속 물고 있었다 — 바로 그 결함을 고쳤다고 적어 놓고서.

> **로컬이 Windows여서 못 봤고, CI가 잡았다.** 태그를 밀고 릴리스 노트를 게시한 **뒤에** ubuntu 러너에서 손자 종료 테스트 두 건이 실패했다. 교훈은 두 가지다.
> 1. **테스트가 플랫폼 차이를 드러내도록 쓰여 있었기 때문에 드러났다.** "종료를 시도했다"가 아니라 "손자가 실제로 멈췄는가"를 marker mtime으로 확인했기 때문에 Windows에서 통과한 코드가 Linux에서 실패했다. 시도 여부만 단정했다면 두 플랫폼 모두 초록이었을 것이다.
> 2. **다음부터는 태그 전에 브랜치로 CI를 한 번 돌린다.** v0.3.2는 그렇게 했다 — 브랜치 push → 6개 매트릭스 green 확인 → 그 다음에 병합·태그. 로컬 `npm test`는 한 플랫폼의 결과일 뿐이다.

POSIX에는 "자손 전체"를 가리키는 수단이 없어 프로세스 그룹을 죽여야 하고, 그러려면 자식이 `detached: true`로 띄워져 그룹 리더여야 한다. 그래서 그룹 종료는 `{ group: true }`를 준 호출자에게만 시도한다 — **추측으로 `kill(-pid)`를 부르면 pid가 우연히 다른 그룹의 pgid와 겹칠 때 남의 프로세스 그룹을 죽이고, CI에서라면 러너 자신이 대상이 될 수 있다.** verify는 detached로 띄우고 플래그를 넘긴다. dispatch는 그룹을 만들지 않으므로 POSIX에서 codex 자신만 종료되는 기존 동작이 유지된다 — 알려진 한계이며, 플래그를 추론이 아니라 명시로 둔 이유다.

### v0.3.0 → v0.3.1 — 새로 넣은 코드가 기존 규율을 지키지 않던 자리들

**patch로 올린 이유**: 공개 계약 변경이 없다. `verify` 리포트의 `spawnedServer` 모양이 바뀌지만(`stopped` → `command`·`exited`·`terminated`·`taskkillExitCode`), v0.3.0에서 하루 만에 잡은 것이라 이 필드에 의존하는 코드가 있을 수 없다.

**세 건 모두 v0.3.0에서 내가 넣은 코드였고, 이 저장소가 오래 지켜온 규율을 새 코드가 어긴 형태였다.**

1. **프로세스 트리 종료 규칙이 두 벌이었다.** dispatch에는 `terminateProcessTree`(Windows `taskkill /T /F` → `SIGKILL`)가 있는데, 나중에 만든 `verify`는 `child.kill('SIGTERM')` 하나로 끝냈다. `npm run dev` 형태의 서버는 부모만 죽고 실제로 듣고 있는 손자가 남아 포트를 물고 있다. 함수를 `engine/task/lib.js`로 옮겨 **두 엔진이 같은 것을 쓰게** 했다(의존 방향은 기존과 같은 handoff → task). 회귀 테스트는 손자가 실제로 살아 있음을 먼저 확인한 뒤 죽이고, marker 파일의 mtime이 더 이상 갱신되지 않는지로 판정한다 — 손자가 애초에 살아 있지 않았다면 그 테스트는 아무것도 증명하지 못하기 때문이다.

2. **리포트가 확인하지 않은 것을 단정했다.** `spawnedServer.stopped: true`를 무조건 적었다. 이 리포트는 sha256으로 해시돼 `verification.evidence`에 증거로 남는데, 그러면 증거가 거짓을 말할 수 있다. 지금은 유예 시간 동안 종료를 기다려 보고 `exited`에 **확인한 사실만** 적는다. 확인하지 못하면 `false`로 남긴다.

3. **`server` 설정이 Windows에서 못 쓰였다.** `shell: false`로 spawn해서 `{"command": "npm", ...}`가 `ENOENT`로 죽었다 — CI 매트릭스에 있고 실제 개발이 이루어지는 플랫폼에서, 문서가 권하는 사용법이 안 되는 상태였다.

   > **여기서 측정이 세 번 필요했다.** ① `.cmd`를 `shell: false`로 spawn → `EINVAL`(Node의 셸 주입 수정 결과). ② `shell: true` → 실행은 되지만 공백 있는 경로가 깨지고 `DEP0190` 경고가 난다. ③ `cmd.exe /d /s /c`로 감싸되 내부 인용을 `\"`로 이스케이프 → 여전히 실패. 정답은 **인용부호 중복(`""`) + `windowsVerbatimArguments: true`** 였다. cmd는 `\"`를 모르고, verbatim이 없으면 Node가 자기 인용을 덧씌워 다시 깨진다. 추측으로는 어느 조합도 맞히지 못했을 것이다.

**같은 릴리스에서 함께 고친 것**: `lint:secrets`가 점으로 시작하는 디렉터리를 전부 건너뛰어 **배포 대상인 `.claude-plugin/`을 검사하지 않았다.** 규칙은 옳은데 walk가 파일에 도달하지 못하는 형태였고, 그건 §2가 경계하는 "조용히 통과하는 검사"와 같다. 제외 목록은 이제 `node_modules`·`.git`·`.duet` 셋뿐이고, 테스트가 임시 트리에 위반을 심어 **제외가 실제로 동작하는지와 제외 밖에서는 반드시 잡히는지**를 함께 확인한다.

`duet-init`은 `.duet/`를 만든다(실설치 스모크에서 걸렸다 — 없으면 `task verify` 설정을 두려는 사용자가 `mkdir`부터 해야 했다). gitignore 대상이라 git에는 아무것도 나타나지 않는다. 설정이 없을 때의 오류 메시지도 `mkdir`과 `copy` 두 단계를 함께 보여준다.

### `task verify` 구현 완료 (Tier 2)

[pipeline-design.md](pipeline-design.md) §9의 검증 하니스를 구현했다(`engine/task/verify.js`, `engine/task/test/verify.test.js`). 이로써 §5의 verification 쓰기 경로 3개가 모두 실재한다 — 그전까지는 §5가 세 개를 세고 §9가 "미구현"이라 밝히는 어긋난 상태였고, **이 문서들은 대상 저장소로 배포되므로** 그 어긋남이 그대로 노출됐다(§2의 v0.2.2 항목 참조).

게이트 성격이 강한 기능이라 "무엇을 못 하는가"를 테스트로 고정했다: 운영으로 읽히는 프로파일은 `allowedProfiles`로도 못 뚫는다, `GET`/`HEAD` 외 메서드는 계획 단계에서 막혀 **요청이 한 건도 나가지 않는다**, 실행된 검사가 0건이면 `PASSED`가 아니라 `PARTIAL`이다, 최대 실행 시간 초과는 건너뜀이 아니라 실패다, 하니스가 띄운 서버만 종료한다.

> **테스트 작성 시 함정(실측)**: 이 테스트들은 부모 프로세스에서 띄운 HTTP 서버를 상대한다. CLI를 `spawnSync`로 부르면 부모 이벤트 루프가 멈춰 서버가 응답하지 못하고, 모든 검사가 타임아웃으로 실패한다 — 그런데 그 실패가 **테스트가 기대한 `FAILED`와 구분되지 않아** 잘못된 이유로 초록이 뜬다(실제로 그렇게 통과한 케이스가 있었다). 서버를 상대하는 CLI 호출은 반드시 비동기 `spawn`을 쓴다.

[engine-externalization.md](engine-externalization.md)는 **게시 전에 먼저 끝냈다** — §3 위치 독립화와 §4 방안 A를 모두 구현했다. 순서를 뒤집은 이유는 외부화가 `install.js`를 크게 들어내는 breaking 변경이고, 대상 저장소가 1곳뿐인 지금이 가장 싼 시점이기 때문이다. 게시 이후였다면 마이그레이션 비용이 붙었다.

§7 결정은 확정됐다: 대상은 Node 저장소로 한정(방안 A 유지), 기존 `tools/` 레이아웃 지원은 종료(잔재는 `duet-init`이 보고만 한다).

§1의 게시 절차도 끝났다(`v0.1.2`까지 태그 게시 완료). 대상 저장소의 `github:` 스펙은 태그를 해석하므로 새 버전에도 태그가 필요하다.

### npm 발행 — **하지 않는다** (2026-07-29 확정)

`github:sdcomms4227/duetcode#<tag>` 스펙을 유지한다. 태그로 해석되고 lockfile에 고정되므로 버전 고정·재현 가능한 설치·업그레이드 경로가 이미 충족되고, 대상 저장소는 아직 1곳이다. README가 밝힌 대로 이건 내부 도구라 공개 레지스트리에 올릴 실익이 크지 않다.

**갱신(2026-07-29): 보류가 아니라 "하지 않는다"로 확정했다.** 사용자 판단이며, 조건부 재검토도 두지 않는다. 아래 두 가지는 예전에 재검토 조건으로 적어 둔 것인데, 이제는 **조건이 성립해도 npm으로 가지 않고 다른 방법으로 푼다**는 뜻이므로 참고 정보로만 남긴다.

1. **대상 저장소가 2곳 이상이 되거나 semver 범위가 필요해질 때.** `github:` 스펙은 `^0.3.0` 같은 범위를 쓸 수 없어 업그레이드가 매번 태그를 손으로 바꾸는 작업이 된다. → 대상이 늘면 태그 갱신을 자동화하는 쪽으로 푼다.
2. **git 없는 빌드 환경에서 설치해야 할 때.** `github:` 스펙은 설치 시점에 git이 필요해 슬림한 도커 이미지나 일부 CI 러너에서 깨진다. → 그때는 tarball(`npm pack` 산출물)이나 사내 레지스트리를 쓴다. 공개 레지스트리 발행은 그 문제의 유일한 해법이 아니다.

> **`duetcode` npm 이름은 선점하지 않는다.** 누가 가져가면 되돌릴 수 없지만, 그 리스크는 감수하기로 한 비용이다 — 이름 선점만을 이유로 발행하는 것은 기술적 필요가 아니라 별개 판단이고, 발행은 사실상 비가역이다(72시간 내에만 unpublish, 같은 버전 재발행 영구 불가). 이름을 잃으면 그때 다른 이름을 쓴다.

**그래서 하지 않아도 되는 일**: `scripts/sync-version.js`의 `github:...#v<버전>` 치환 패턴은 그대로 둔다. 레지스트리 스펙으로 바꿀 일이 없으므로 §8의 동기화 대상도 바뀌지 않는다. 패키지 자체는 발행 가능한 상태이지만(`files`·`bin` 검증은 `scripts/test/package-meta.test.js`가 계속 강제한다) 그것은 tarball 설치를 위한 것이지 발행 준비가 아니다.

## 8. 버전 참조 동기화

`v0.1.2` 릴리스 뒤 설치 참조가 `#v0.1.1`에 남은 문제를 막기 위해, `scripts/sync-version.js`가 `package.json`을 기준으로 README·설치 스킬·설치 스니펫·`.claude-plugin/plugin.json`의 버전을 맞춘다.

```bash
npm run version:sync    # 맞춘다
npm run version:check   # 안 고치고, 어긋나 있으면 exit 1
```

버전은 `npm version <newversion> --no-git-tag-version`으로 올린다. `version` 라이프사이클이 참조를 동기화하지만 커밋과 태그는 만들지 않는다. 변경을 검토한 사람이 별도로 커밋·태그·푸시한다. `npm test`는 참조 드리프트를 실패로 잡는다.

릴리스 기록의 과거 버전과 `docs/engine-externalization.md`의 설계 예시는 동기화하지 않는다. 대상 파일의 구조가 바뀌어 패턴이 맞지 않으면 스크립트는 실패한다.
