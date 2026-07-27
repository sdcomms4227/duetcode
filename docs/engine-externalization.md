# 엔진 외부화 설계 — `tools/`를 대상 저장소에서 gitignore하기

> 상태: **구현 완료**(§3 위치 독립화 + §4 방안 A). 이 문서는 이제 설계 제안이 아니라 **현재 구조의 근거 기록**이다.
>
> §7 결정은 모두 확정됐다: public 전환 완료(A 채택), 대상은 Node 저장소로 한정, 기존 `tools/` 레이아웃 지원은 대상이 1곳일 때 종료했다(잔재는 `duet-init`이 보고만 하고 지우지 않는다).
>
> 발단: 첫 설치 대상 저장소에서 "`tools/`는 그 저장소의 코드가 아니라 외부 도구이므로 `.omc`/`.omx`처럼 gitignore하고 싶다"는 요구. 이 문서는 그 요구를 duetcode canonical 쪽 작업으로 옮긴 것이다.

## 1. 목표 / 비목표

**목표**
- 대상 저장소가 `tools/`(설치된 엔진 실체)를 **gitignore**할 수 있게 한다.
- 엔진이 **어느 경로에 놓여도** 동작하게 한다(`node_modules/duetcode/`, `.duet/engine/`, 기존 `tools/` 모두).
- 대상 저장소가 사용 중인 **엔진 버전을 커밋 가능한 형태로 고정**한다(현재는 버전 표식이 전혀 없다).

**비목표**
- **`TASK.md`는 계속 커밋한다.** 별도로 검토했고 gitignore 대상이 아니다 — 근거는 [§6](#6-taskmd는-왜-이-범위가-아닌가).
- 상태머신 의미론·전이 규칙·lint 규칙 변경 없음. 이 작업은 **배치(placement) 리팩터링**이다.
- 기존 `tools/` 레이아웃 설치를 즉시 폐기하지 않는다(마이그레이션 경로 유지).

## 2. 현재 구조가 gitignore를 막는 지점 (실측)

엔진 코드·대상 저장소 상태·대상 저장소 설정이 **한 디렉터리에 섞여 있어** 통째로 gitignore할 수 없다.

| # | 지점 | 문제 |
|---|------|------|
| B1 | `engine/handoff/lib.js:6` — `REPO_ROOT = path.resolve(__dirname, '..', '..')` | "엔진은 `<repo>/tools/*`에 있다"는 **위치 가정**. 엔진을 옮기면 repo root를 오인한다 |
| B2 | `engine/handoff/lib.js:7` — `TASK_CLI = <REPO_ROOT>/tools/task/index.js` | 형제 엔진을 **경로 문자열로** 찾는다. B1이 틀리면 같이 틀린다 |
| B3 | `engine/handoff/lib.js:8` — `DEFAULT_STATE_DIR = __dirname/state` | **런타임 상태가 엔진 디렉터리 안**에 있다. 엔진이 재설치·재설치 가능해지면 상태가 함께 날아간다 |
| B4 | `engine/task/verify.example.json` (+ 대상의 `verify.local.json`) | **대상 저장소 소유 설정이 엔진 디렉터리 안**에 있다. 엔진을 덮어쓰면 같이 위험해진다 |
| B5 | `engine/task/test/helpers.js:58` — `path.resolve('tools/task/index.js')` | 테스트가 **설치된 사본 경로를 하드코딩**한다. 엔진 위치가 바뀌면 전 테스트가 깨진다 |
| B6 | 이 저장소에 **root `package.json`이 없다** | npm 배포 경로(§4 방안 A)를 택하면 신설이 필요하다 |
| B7 | 버전 표식 부재 | 대상이 어느 엔진 리비전을 쓰는지 알 방법이 `--engine-only --force` 후 `git diff` 육안 확인뿐 |

부수적으로 사용자 대상 문자열도 `tools/` 경로를 하드코딩한다 — 동작에는 영향이 없지만 함께 정리 대상이다:
`engine/handoff/build-prompt.js:97`, `engine/handoff/dispatch.js:42`, `engine/handoff/parse-result.js:119`, `templates/package-json-snippet.json`, `templates/gitignore-snippet.txt`.

## 3. 1단계 — 위치 독립화 (방안 A/B 공통, 작업량의 대부분)

**어떤 배포 방식을 택하든 먼저 해야 하고, 이것만으로도 독립적 가치가 있다.** 아래를 마치면 엔진은 위치에 무관해진다.

### 3.1 repo root 해석 (B1)

위치 추론을 **명시적 해석**으로 교체한다. 우선순위:

1. `process.env.DUET_REPO_ROOT` (명시 오버라이드 — worktree·모노레포·테스트용)
2. `git rev-parse --show-toplevel` (cwd 기준)
3. `process.cwd()` (git 밖 폴백)

`git rev-parse` 실패를 조용히 삼키지 않는다. 3번으로 폴백했다는 사실은 `--verbose`류에서 확인 가능해야 한다 — 잘못된 root로 조용히 동작하면 다른 저장소의 `TASK.md`를 건드릴 수 있다.

### 3.2 형제 엔진 참조 (B2)

`TASK_CLI` 경로 join을 없애고 `require('../task/lib.js')`로 직접 참조한다. 프로세스 스폰이 꼭 필요한 경우(TTY 격리 등)만 `require.resolve('../task/index.js')`를 쓴다 — 어느 쪽이든 **엔진 내부의 상대 참조**이므로 위치에 무관하다.

### 3.3 런타임 상태 이전 (B3)

`DEFAULT_STATE_DIR`을 `<REPO_ROOT>/.duet/state/`로 옮긴다. 근거: 엔진 디렉터리는 **언제든 삭제·재설치되는 대상**이 되므로 상태를 두면 안 된다. `HANDOFF_STATE_DIR` 오버라이드는 그대로 유지한다(`lib.js:43`).

### 3.4 대상 저장소 설정 이전 (B4)

- `verify.example.json` → `templates/`로 이동(엔진 밖).
- 실사용 위치 → `<REPO_ROOT>/.duet/verify.json`.
- 기존 `tools/task/verify.local.json`이 있으면 **읽어주되 경고**한다(마이그레이션 유예). 유예 종료 시점은 §5.

### 3.5 테스트 경로 (B5)

`engine/task/test/helpers.js`가 설치 사본이 아니라 **`engine/`을 직접** 대상으로 삼도록 바꾼다(`path.resolve(__dirname, '../index.js')`). 부수 효과로 CLAUDE.md "Commands" 절의 자기설치 절차(`--target <scratch-dir>` 후 테스트)가 불필요해진다 — 이 저장소에서 바로 `node --test engine/*/test/*.test.js`가 돈다. **CLAUDE.md 갱신 필요.**

### 3.6 버전 표식 (B7)

엔진이 자기 버전을 보고할 수 있어야 한다(`task --version`). 소스는 `.claude-plugin/plugin.json`의 `version`(현재 `0.1.0`)을 단일 소스로 삼는다. 방안 A를 택하면 신설 `package.json`과 **버전이 갈라지지 않도록** 한쪽에서 읽어 쓰거나 릴리스 스크립트가 동기화한다.

## 4. 2단계 — 배포 방식 (택일)

### 방안 A — npm devDependency (권장)

```jsonc
// 대상 저장소 package.json
"devDependencies": { "duetcode": "github:sdcomms4227/duetcode#v0.1.0" }
"scripts": { "task": "duet-task", "handoff": "duet-handoff" }
```

duetcode에 root `package.json` 신설(B6):

```jsonc
{ "name": "duetcode", "version": "0.1.0",
  "bin": { "duet-task": "engine/task/index.js", "duet-handoff": "engine/handoff/dispatch.js" },
  "files": ["engine", "templates", "commands", "skills"],
  "dependencies": { "yaml": "^2.8.1" },
  "engines": { "node": ">=18" } }
```

- **`tools/`가 아예 생기지 않는다** — `node_modules/`가 이미 gitignore이므로 목표가 자동 달성된다.
- **버전 드리프트가 같이 해결된다(B7)** — `package-lock.json`에 커밋 SHA가 박혀 "어느 엔진을 쓰는지"가 커밋되고, 업그레이드는 `npm i`로 명시적 커밋이 된다.
- `yaml`이 엔진 의존성으로 따라오므로 대상의 devDependencies에서 뺄 수 있다.
- 대상 CI가 이미 `npm ci`를 돌면(`templates/task-lint.yml`로 설치된 워크플로가 그렇다) **CI 변경이 없다.**
- `install.js`의 역할이 축소된다 — 엔진 복사가 사라지고 `TASK.md`·규약 문서·CI·gitignore 스니펫 **부트스트랩만** 남는다.

**~~⚠ 리스크: private 저장소 인증~~ — 해소됨.** 이 문서를 처음 쓸 때는 저장소가 private이라 대상 CI의 `npm ci`가 인증 실패로 깨지는 것이 방안 A의 실질 관문이었다. duetcode를 **public으로 배포하면서 이 관문이 사라졌다** — 대상 CI가 GitHub 호스티드 러너여도 인증 없이 설치된다. PAT 배포나 self-hosted 러너 같은 우회책은 더 이상 검토 대상이 아니다.

### 방안 B — `.duet/` 로컬 설치 + gitignore (npm을 쓰지 않는 대상용)

```
.duet/           ← gitignore (엔진 실체 + 상태 + 로컬 설정)
  engine/  state/  verify.json
.duet.json       ← 커밋 (소스 + 고정 버전만 기록)
```

- `.duet.json` = `{ "source": "github:sdcomms4227/duetcode", "version": "0.1.0" }` → **버전 드리프트 봉쇄(B7)**
- `install.js`가 `.duet/engine`에 배치. `--engine-only`의 자연스러운 후계.
- 대상 scripts: `node .duet/engine/task/index.js ...`
- **엔진 부재 시 조용히 실패하지 않는다** — 래퍼가 설치 명령을 안내하고 비정상 종료해야 한다.
- npm 레지스트리·인증 불필요.

**대가**: 대상 CI가 clone만으로 검증 불가 → 설치 스텝 추가 필요 → 결국 인증 문제가 같은 자리로 돌아온다. `npm ci` 자동성도 잃는다.

### 판단

| | A (npm) | B (.duet/) |
|---|---|---|
| 대상 `tools/` 제거 | ✅ | ✅ |
| 버전 고정 | ✅ lockfile 자동 | ⚠ `.duet.json` 수동 |
| 대상 CI 변경 | ❌ 불필요(`npm ci` 사용 시) | ⚠ 설치 스텝 추가 |
| private 저장소 지원 | ⚠ 인증 필요 | ✅ |
| npm 없는 대상(비-Node 저장소) | ❌ | ✅ |

**public 배포가 완료되었으므로 A가 기본안이다.** 마지막 행은 duetcode가 Node 저장소 외로 확장될 계획이 있다면 A의 감점 요인이다.

## 5. 마이그레이션 (기존 설치 대상)

현재 실사용 대상은 초기 설치 저장소 1곳뿐이다. 파괴적 전환을 피한다.

1. 1단계(§3)만 먼저 릴리스 → 기존 `tools/` 레이아웃에서 **그대로 동작**해야 한다(위치 독립화는 하위호환이다).
2. 대상에서 `--engine-only --force`로 동기화 → `npm run task:lint` / `task:test` / `handoff:test` 통과 확인.
3. 2단계 배포 방식 전환 → 대상에서 `tools/` 삭제 + `.gitignore`에 `/tools/`·`/.duet/` 추가 + scripts 교체.
4. 대상의 `CLAUDE.md` 동기화 절차 문구(`install.js --engine-only --force`) 갱신.
5. 기존 `tools/task/verify.local.json`·`tools/handoff/state/` gitignore 항목 정리(§3.3·§3.4에서 경로가 바뀐다).

`templates/gitignore-snippet.txt`도 새 경로로 갱신한다.

## 6. `TASK.md`는 왜 이 범위가 아닌가

같은 폴더에 있었을 뿐 성격이 정반대다. gitignore 시 **코드에 실재하는 하드 블로커**:

| # | 지점 | 영향 |
|---|------|------|
| 1 | `engine/task/lib.js:138` — `git show <sha>:TASK.md` | `archive commit:<sha>` 경로가 동작 불가. 보존 참조 2개 중 하나가 사망(`docs:` 경로는 생존) |
| 2 | `designCheckpoint`에 commit SHA 기록 | 그 SHA를 체크아웃해도 당시 Task 상태를 복원할 수 없다 — "복귀 지점"이 반쪽이 된다 |
| 3 | [pipeline-design.md §2](pipeline-design.md) — *"최종 방어선은 커밋 전 사람의 `git diff TASK.md`"* | **DONE 승인 게이트의 최종 방어선이 소멸.** `approve-partial`의 TTY 검사는 설계상 신원을 보증하지 않으며, 그 공백을 git diff가 메운다 |
| 4 | `templates/task-lint.yml` (push/PR마다 `task:lint`) | lint 대상 소멸 |

3번이 결정적이다 — 에이전트가 스스로 `DONE`으로 전이한 것을 사람이 사후 검증할 수단이 하나도 남지 않는다.

`.omc`/`.omx`가 gitignore인 이유는 "AI 관련 파일이라서"가 아니라 **날려도 재설치되기 때문**이다. `tools/`는 재설치 가능하고, `TASK.md`는 재생성 불가능한 결정 기록이다. 이 문서의 범위는 전자뿐이다.

(참고: 커밋 노이즈가 동기라면 해법은 gitignore가 아니라 전이마다 커밋하지 않는 운용이다. 여러 worktree 동시 진행이 동기라면 `TASK_STATE_FILE` env(`engine/handoff/lib.js:39`)로 파일을 분리하는 쪽이 정답이다.)

## 7. 결정 필요 항목

착수 전 사용자 확정이 필요하다.

1. ~~duetcode를 public으로 전환할 수 있는가?~~ → **완료. 방안 A 채택.**
2. duetcode를 **Node 외 저장소**에도 설치할 계획이 있는가? → 있으면 A가 부적합해진다.
3. 기존 `tools/` 레이아웃 지원을 **언제 끊을 것인가** — §3.4 유예의 종료 시점.

## 8. 완료 조건

- [x] 엔진이 위치에 무관하게 동작한다 — repo root를 `DUET_REPO_ROOT` → `git rev-parse` → cwd로 **해석**하고, 형제 엔진은 `require.resolve`로 찾는다(B1·B2).
- [x] `engine/`의 테스트가 자기설치 없이 직접 돈다(B5). 이 저장소에서 `npm test` 하나로 끝난다.
- [x] 런타임 상태(`<root>/.duet/state/`)와 대상 설정(`.duet/verify.json`)이 엔진 밖에 있다(B3·B4).
- [x] 대상 저장소에 엔진 사본이 **아예 생기지 않는다** — gitignore할 `tools/`가 없다.
- [x] 커밋되는 버전 표식은 대상의 lockfile이다(B7). `duet-task --version`으로 실행 중인 엔진을 확인한다.
- [x] `TASK.md` 관련 회귀 0 — 상태머신·lint·archive·git diff 게이트 전부 불변(task 25/25, handoff 52/52).
- [x] `CLAUDE.md`·`README.md`·`docs/pipeline-design.md`·`templates/*`·`skills/*`·`commands/*` 정합성 갱신.
