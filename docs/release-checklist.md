# 배포 전 체크리스트 — duetcode 첫 공개

> 이 문서는 `cc-symphony` → `duetcode` 개명·신규 저장소 결정이 내려진 세션의 **인수인계 기록**이다.
> 결정의 *결과*는 코드에 이미 반영되어 있으므로, 여기에는 **코드만 봐서는 알 수 없는 근거**와 **아직 하지 않은 일**만 적는다.
>
> 관련 문서: 보안 검토는 [public-release-readiness.md](public-release-readiness.md), 다음 리팩터링 계획은 [engine-externalization.md](engine-externalization.md).

## 1. 지금 당장 해야 할 것 (순서 중요)

아직 **로컬 커밋까지만** 되어 있다. GitHub에는 아무것도 올라가지 않았다.

```bash
cd C:\Project\duetcode

# 1) author 이메일 확인 — 이미 설정되어 있어야 한다
git config user.email        # → sdcomms4227@users.noreply.github.com

# 2) public 저장소 생성 + push
gh repo create duetcode --public --source . --push
```

push 직후 **웹 UI에서** 처리해야 하는 것(CLI로 안 되는 항목):

- [ ] Settings → Code security → **Secret scanning** 활성화
- [ ] 같은 화면 → **Push protection** 활성화
- [ ] 구 `cc-symphony` 저장소 → Settings → **Archive**(삭제 금지, 아래 §4 참조)

### 시크릿 스캐너 오탐 대응 방침

스캔을 켜면 `engine/handoff/test/redaction.test.js`의 픽스처가 잡힐 수 있다. **전부 의도된 가짜 값**이다(상세: public-release-readiness §3.1).

> **잡히면 예외 처리로 무시하지 말고, 픽스처를 더 명백한 가짜 값으로 바꾼다.**
> 이유: 예외 목록이 길어질수록 진짜 경보에 둔감해진다. 그게 픽스처 노출보다 큰 위험이다.

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
| repo root 오버라이드 env | `DUET_REPO_ROOT` | 구현 완료 |
| bin 이름 | `duet-task`, `duet-handoff`, `duet-init` | 구현 완료 |
| 버전 | `0.1.0` | 신규 저장소이므로 초기화 (구 저장소는 `0.1.1`이었다) |

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
scripts/test   16 / 16
```

> 이 저장소에서 `npm test` 하나로 전부 돈다(엔진 외부화 이후 자기설치 절차가 사라졌다).

> 개명 직후에는 22 / 49 / 7이었다. 러너 계약 3건씩과 부트스트랩 회귀가 더해졌고, 엔진 외부화로 설치기 테스트가 새 계약(엔진 미복사·duet-* 스크립트·잔재 보고)에 맞게 재작성되면서 16으로 정리됐다.

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

남은 것은 §1의 게시 절차뿐이다. 게시 후 태그(`v0.1.0`)를 붙여야 대상 저장소의 `github:` 스펙이 해석된다 — 태그 없이는 설치가 실패한다.
