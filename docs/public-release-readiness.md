# 공개 배포 보안 검토 — duetcode public 배포

> 상태: **검토 완료 · 차단 요소 없음**.
>
> 이 검토는 `cc-symphony`라는 이름의 private 저장소를 대상으로 수행했다. 이후 **`duetcode`라는 신규 public 저장소로 새 이력을 시작**하기로 결정했으므로, 아래 §3.3(이력 정리)과 §4(개인 이메일)의 결론은 **신규 저장소에서 더 강한 형태로 자동 달성**된다 — 상세는 §4 참조.
>
> 목적: 이 코드베이스를 공개할 때의 노출 위험을 실측하고, 배포 전 필요한 조치를 기록한다.
> 발단: [engine-externalization.md §4 방안 A](engine-externalization.md)(npm devDependency 배포)가 대상 저장소 CI에서 private 인증을 요구하는데, public 전환이 그 문제를 통째로 없애기 때문이다.

## 1. 검토 범위

`gh` 원격 조회 없이 로컬 저장소를 전수 스캔했다.

- **워킹트리** — 추적 파일 40개 전부
- **git 이력 전체** — 18 커밋, `git log -p --all` 전문
- **미추적 로컬 상태** — `.omc/`, `.omx/`가 실제로 커밋된 적 있는지 이력에서 교차 확인

탐지 패턴: 자격증명(`password`/`token`/`api_key`/`secret`/PEM/`ghp_`/`github_pat_`), 사설 IP 대역, 개인 이메일, 설치 대상 저장소·고객사 고유명, DB 스키마명, 로컬 절대경로.

## 2. 결론

**공개 전환에 보안상 차단 요소는 없다.**

이 저장소는 처음부터 특정 대상 저장소에 종속되지 않게 설계되었고(`templates/`·`skills/`·`commands/`·`docs/`·`CLAUDE.md`·`README.md` 전수 검색에서 대상 고유명 0건), 커밋된 적 있는 파일과 현재 추적 파일이 정확히 일치해 **이력 재작성(`git filter-repo` 등)이 불필요**하다.

## 3. 상세 결과

### 3.1 시크릿 — 없음

패턴에 걸린 항목은 **전부 redaction 테스트 픽스처**다. 이 저장소가 시크릿 관련 문자열을 많이 포함하는 이유는 역설적으로 **시크릿을 가려내는 코드**이기 때문이다.

| 매칭 | 실체 | 위치 |
|---|---|---|
| `-----BEGIN PRIVATE KEY-----` | 본문이 `ZmFrZS1wcml2YXRlLWtleS1tYXRlcmlhbA==` = base64(`fake-private-key-material`) | `engine/handoff/test/redaction.test.js:17` |
| `wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY` | AWS 공식 문서의 예시 키(이미 전 세계 공개) | `engine/handoff/test/redaction.test.js:111` |
| `xoxb-1234…`, `AIza…`, `Basic dXNlcjpwYXNzd29yZA==` | 자리표시자. 마지막 것은 base64(`user:password`) | 동 파일 |
| `token: …` 다수 | `crypto.randomUUID()` 기반 **락 소유권 토큰**. 자격증명이 아니다 | `engine/handoff/lib.js:165`, `test/lock.test.js` |

**향후 규칙**: redaction 테스트에 새 픽스처를 추가할 때는 실제 형식을 흉내 내되 **명백히 가짜인 값**(`fake-`, `EXAMPLE`, 반복 문자)만 쓴다. 실제로 발급받은 값은 만료됐더라도 넣지 않는다 — 공개 저장소의 시크릿 스캐너가 오탐 경보를 발생시키고, 그 경보에 둔감해지는 것이 진짜 위험이다.

### 3.2 설치 대상·고객사·인프라 정보 — 0건

`templates/`, `skills/`, `commands/`, `docs/pipeline-design.md`, `docs/pipeline-workflow-example.md`, `CLAUDE.md`, `README.md`, `AGENTS.md`:

- 설치 대상 저장소명·조직명·고객사명 — 없음
- DB 스키마명·프로파일명 — 없음
- 사설 IP, 내부 호스트, 빌드 러너 주소 — 없음
- 설정 암호화 도구·키 관련 서술 — 없음

`templates/collaboration-protocol.md`는 대상 저장소 규약의 일반화 버전이라 고유명이 남아있지 않다.

### 3.3 git 이력 — 정리 불필요

```
역대 커밋된 고유 경로 : 40
현재 추적 중인 파일   : 40      ← 일치
```

**커밋됐다가 삭제된 파일이 하나도 없다.** "지워서 트리에는 없지만 blob으로 남아 접근 가능한" 파일이 존재하지 않으므로 이력 재작성이 필요 없다.

### 3.4 미추적 로컬 상태 — 차단됨

`.omc/`, `.omx/`에는 개발 세션 로그(대화 요약·파일 경로·설치 대상 저장소 언급)가 실제로 들어있다. `.gitignore:6-7`로 차단되어 있고 **이력상 한 번도 커밋된 적 없음**을 확인했다.

**공개 후에도 이 상태가 유지되어야 한다.** `git add -A`류 조작 시 gitignore가 지켜주지만, `git add -f`나 gitignore 편집 사고를 막지는 못한다. §5-3 참조.

## 4. 반영된 조치

| # | 조치 | 위치 |
|---|------|------|
| 1 | **개인 이메일 제거** — `sdcomms4227@gmail.com` → `sdcomms4227@users.noreply.github.com` | `.claude-plugin/marketplace.json:6` |
| 2 | **설계 문서 익명화** — 설치 대상 저장소명 3곳 제거 | `docs/engine-externalization.md` |
| 3 | **저장소 개명** — `cc-symphony` → `duetcode`. 신규 public 저장소로 새 이력 시작 | 전 범위(추적 파일 52건) |
| 4 | **`install.js` 파괴적 시맨틱 경고** — README 상단에 배치 | `README.md` |

**커밋 author 이메일 문제는 신규 저장소 결정으로 소멸했다.** 구 저장소의 18개 커밋 전부에 개인 이메일이 박혀 있었고, 이력 재작성 비용(모든 SHA 변경) 대비 실익이 낮아 원래는 보류했던 항목이다. **`duetcode`는 새 이력으로 시작하므로 `git filter-repo` 없이 첫 커밋부터 noreply 주소를 쓴다** — repo init 전에 `git config user.email sdcomms4227@users.noreply.github.com`을 반드시 설정한다.

구 `cc-symphony` 저장소는 **삭제하지 않고 archive**하며, README에 이관 안내를 남긴다(개명으로 GitHub 자동 리다이렉트를 받지 못하므로).

## 5. 잔여 권장 조치(미반영)

전환을 막지는 않지만 공개 전 처리하는 편이 낫다.

1. ~~**`install.js`의 파괴적 시맨틱을 README에 경고로 명시.**~~ → **반영 완료.** README 상단에 경고 블록을 배치했다. 남의 저장소를 수정하는 도구를 공개하는 것이므로 첫 화면에 있어야 한다는 판단.

2. ~~**semver 정책 선언.**~~ → **반영 완료.** README "Versioning" 절에서 공개 표면을 front matter 스키마·상태 전이표·CLI 표면(명령·플래그·exit code)으로 정의했다. [engine-externalization.md §4 방안 A](engine-externalization.md)로 가면 대상이 lockfile로 특정 리비전에 물리므로 이 정의가 계약이 된다.

3. **시크릿 스캐닝 활성화.**
   공개 전환 직후 GitHub Secret scanning + push protection을 켠다. §3.1의 테스트 픽스처가 오탐으로 잡힐 수 있으므로, 잡히면 제외하지 말고 **픽스처를 더 명백한 가짜 값으로 바꾸는 쪽**을 택한다.

## 6. 위협 모델 — 공개의 실제 비용

노출 위험은 위에서 정리한 대로 사실상 없다. 공개의 진짜 비용은 **유출이 아니라 책임**이다.

- **배포 책임**: 임의의 저장소가 설치할 수 있게 된다. `install.js` 버그가 남의 저장소를 손상시킬 수 있다.
- **유지보수 유입**: issue·PR 대응 의무와 호환성 유지 압력이 생긴다.
- **redaction 로직 공개는 위험이 아니다.** 정규식이 공개되면 우회할 수 있다는 우려가 나올 수 있으나, [pipeline-design.md §2](pipeline-design.md)가 이미 선언했듯 이 장치들은 **"협조적이지만 실수할 수 있는 에이전트"를 위한 가드레일**이지 악의적 우회를 막는 보안 경계가 아니다. 로컬 로그 위생 목적이고, 공격자는 애초에 그 로그가 있는 기기에 접근해야 한다.

## 7. 전환 체크리스트

- [x] 워킹트리 시크릿 스캔
- [x] git 이력 전체 시크릿 스캔
- [x] 대상 저장소·고객사·인프라 고유명 스캔
- [x] `.omc`/`.omx` 미커밋 확인
- [x] 개인 이메일 정리(§4-1)
- [x] 설계 문서 익명화(§4-2)
- [x] README에 `install.js` 파괴적 시맨틱 경고 추가(§5-1)
- [x] `duetcode`로 전 범위 개명(§4-3)
- [x] [engine-externalization.md §4 방안 A](engine-externalization.md) 확정
- [x] semver 정책 선언(§5-2)
- [x] `git config user.email` noreply 설정(§4) — 커밋 author가 이미 noreply 주소다
- [x] [engine-externalization.md](engine-externalization.md) §3·§4 구현 — 게시 전에 완료(breaking 변경이라 대상이 1곳일 때 처리)
- [ ] **신규 public 저장소 `duetcode` 생성 + 초기 커밋**
- [ ] Secret scanning + push protection 활성화(§5-3)
- [ ] 구 `cc-symphony` 저장소 archive + 이관 안내(§4)
- [ ] 게시 후 `v0.1.0` 태그 — 대상의 `github:` 스펙이 이 태그를 해석한다
