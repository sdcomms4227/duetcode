# 배포 전 체크리스트 — duetcode 첫 공개

> 이 문서는 `cc-symphony` → `duetcode` 개명·신규 저장소 결정이 내려진 세션의 **인수인계 기록**이다.
> 결정의 *결과*는 코드에 이미 반영되어 있으므로, 여기에는 **코드만 봐서는 알 수 없는 근거**와 **아직 하지 않은 일**만 적는다.
>
> 관련 문서: 보안 검토는 [public-release-readiness.md](public-release-readiness.md), 다음 리팩터링 계획은 [engine-externalization.md](engine-externalization.md).

## 1. 게시 — **완료**

`https://github.com/sdcomms4227/duetcode` public, 최신 릴리스 **`v0.2.0`**.

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
| repo root 오버라이드 env | `DUET_REPO_ROOT` | 구현 완료 — `duet-handoff` 한정(task CLI는 cwd 기준) |
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
task:lint      통과
task:test      30 / 30
handoff:test   52 / 52
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

`ensureFileFromTemplate`는 **skip-if-exists**다. 따라서 기존 대상 저장소에 재설치하면 **구 파일이 남은 채 신 파일이 추가로 생성되어 6개가 공존**한다. 자동 정리는 없다.

대상 저장소에서 수동으로:

1. 구 `docs/cc-symphony-*.md` 3개 삭제
2. 그 문서를 참조하던 곳 링크 수정 — 대상의 `CLAUDE.md`/`AGENTS.md`, 그리고 대상 `TASK.md` 본문
3. `.gitignore`의 `# --- cc-symphony pipeline` 주석 블록 갱신

`scripts/test/install.test.js`에는 이 파일명 단정이 없어 테스트로는 안 잡힌다. **눈으로 확인해야 한다.**

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

[engine-externalization.md](engine-externalization.md)는 **게시 전에 먼저 끝냈다** — §3 위치 독립화와 §4 방안 A를 모두 구현했다. 순서를 뒤집은 이유는 외부화가 `install.js`를 크게 들어내는 breaking 변경이고, 대상 저장소가 1곳뿐인 지금이 가장 싼 시점이기 때문이다. 게시 이후였다면 마이그레이션 비용이 붙었다.

§7 결정은 확정됐다: 대상은 Node 저장소로 한정(방안 A 유지), 기존 `tools/` 레이아웃 지원은 종료(잔재는 `duet-init`이 보고만 한다).

§1의 게시 절차도 끝났다(`v0.1.2`까지 태그 게시 완료). 대상 저장소의 `github:` 스펙은 태그를 해석하므로 새 버전에도 태그가 필요하다.

## 8. 버전 참조 동기화

`v0.1.2` 릴리스 뒤 설치 참조가 `#v0.1.1`에 남은 문제를 막기 위해, `scripts/sync-version.js`가 `package.json`을 기준으로 README·설치 스킬·설치 스니펫·`.claude-plugin/plugin.json`의 버전을 맞춘다.

```bash
npm run version:sync    # 맞춘다
npm run version:check   # 안 고치고, 어긋나 있으면 exit 1
```

버전은 `npm version <newversion> --no-git-tag-version`으로 올린다. `version` 라이프사이클이 참조를 동기화하지만 커밋과 태그는 만들지 않는다. 변경을 검토한 사람이 별도로 커밋·태그·푸시한다. `npm test`는 참조 드리프트를 실패로 잡는다.

릴리스 기록의 과거 버전과 `docs/engine-externalization.md`의 설계 예시는 동기화하지 않는다. 대상 파일의 구조가 바뀌어 패턴이 맞지 않으면 스크립트는 실패한다.
