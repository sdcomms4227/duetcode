---
name: pipeline-install
description: duetcode 파이프라인(TASK.md 상태머신 + Codex 핸드오프)을 현재 저장소에 설치·부트스트랩한다. 사용자가 "duetcode 설치", "이 프로젝트에 파이프라인 붙여줘", "TASK.md 워크플로 세팅" 등을 요청할 때 사용. 엔진은 duetcode devDependency로 설치되고, package.json·CI·.gitignore·TASK.md·규약 문서를 멱등하게 스캐폴딩한다.
---

# duetcode pipeline 설치

이 스킬은 duetcode 상태머신 엔진과 협업 규약을 **현재(또는 지정한) 저장소**에 배치한다.

## 절차

1. 대상이 git 저장소인지 확인한다(`git rev-parse --show-toplevel`). 아니면 사용자에게 `git init` 여부를 묻는다.

2. 엔진을 devDependency로 걸고 부트스트랩한다.

   ```bash
   npm i -D github:sdcomms4227/duetcode#v0.3.0
   npx duet-init
   ```

   - **코어만**(Codex 핸드오프 없이 task 상태머신 + lint + CI): `npx duet-init --no-handoff`
   - 기본은 "없으면 생성, 있으면 보존" — 기존 `TASK.md`·`package.json`·`.gitignore` 사용자 내용을 덮어쓰지 않는다.
   - **엔진은 대상 저장소에 복사되지 않는다.** `node_modules/duetcode`에서 실행되며 버전은 lockfile에 고정된다. 갱신은 태그를 올리고 `npm install`.

3. 의존성 설치와 검증:

   ```bash
   npm install
   npm run task:lint      # TASK.md(IDLE) 통과 확인
   npx duet-task --version
   ```

   엔진 테스트는 duetcode 저장소에서 돈다 — 대상 저장소가 다시 돌릴 필요가 없다.

4. `docs/duetcode-collaboration-protocol.md`의 `<...>` 자리표시자(모델·기본 브랜치·불변식·언어)를 프로젝트에 맞게 채우고, 저장소의 에이전트 지침 문서(`CLAUDE.md`/`AGENTS.md`)에서 이 문서를 협업 규약 단일 소스로 참조하게 한다.

5. `package.json` 스크립트 충돌이 보고되면(기존에 `task`/`handoff` 등 동명 스크립트가 있던 경우) 사용자에게 알리고 수동 조정한다.

## 주의

- 설치는 파일 생성·수정을 수반하므로, 커밋은 사용자 승인 후에만 수행한다.
- Codex 핸드오프(`npm run handoff`)는 `codex` CLI가 있어야 동작한다. 없으면 코어만으로도 상태머신·lint·CI는 완전히 동작한다.
- 자세한 설계·상태머신·명령 표면은 설치된 `docs/duetcode-pipeline-design.md`, 운영 흐름은 `docs/duetcode-pipeline-workflow-example.md` 참조.
