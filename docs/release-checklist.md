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
| 로컬 상태 디렉터리 | `.duet/` | 미구현. engine-externalization §3.3·§3.4에서 사용 |
| repo root 오버라이드 env | `DUET_REPO_ROOT` | 미구현. 동 문서 §3.1 |
| 계획된 bin 이름 | `duet-task`, `duet-handoff` | 미구현. 동 문서 §4 방안 A |
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
task:test      22 / 22
handoff:test   49 / 49
scripts/test    7 /  7
```

재현 절차(이 저장소에는 root `package.json`이 없어 자기설치가 필요하다):

```bash
node scripts/install.js --target <scratch-dir>
cd <scratch-dir> && npm install
npm run task:lint && npm run task:test && npm run handoff:test
cd <repo> && node --test scripts/test/*.test.js
```

> engine-externalization §3.5를 구현하면 이 자기설치 절차가 없어지고 `node --test engine/*/test/*.test.js`로 직접 돌게 된다. 그때 **CLAUDE.md "Commands" 절을 반드시 갱신**해야 한다.

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

## 7. 다음 작업

배포가 끝나면 [engine-externalization.md](engine-externalization.md) §3(위치 독립화)이 다음 Task다. public 배포로 §4 방안 A(npm devDependency)의 유일한 관문이던 private 인증 문제가 해소되어, **방안 A가 확정안**이 되었다.

착수 전 남은 결정(동 문서 §7):

- [ ] Node 외 저장소에도 설치할 계획이 있는가? → 있으면 방안 A가 부적합해진다
- [ ] 기존 `tools/` 레이아웃 지원을 언제 끊을 것인가
