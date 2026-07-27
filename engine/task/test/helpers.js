const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BODY = `
# TASK.md — Active Task 상태

## Active Task

### 요구사항과 완료 조건
- 실제 요구사항

### 필독 문서와 불변식
- 실제 불변식

### 영향 범위
- 실제 영향 범위

### 확정된 설계와 미확정 사항
- **확정**: 테스트

### Review와 다음 행동
- **Review 결과**: 검토 대기
- **다음 담당자**: Claude
- **다음 행동**: 검토
`;
function share(overrides = '') {
  return `---
id: task-test # 보존할 주석
status: REVIEW
objective: CLI 테스트
requester: tester
roles:
  designer: Claude
  implementer: Codex
  reviewer: Claude
branch: pipeline-automation
designCheckpoint: abc123
issue: null
highRisk: false
verification:
  status: PASSED
  failedCount: 0
  partialApproved: false
  approvedBy: null
  approvedAt: null
  updated: 2026-07-14T00:00:00Z
blocked: null
closure: null
updated: 2026-07-14T00:00:00Z
${overrides}---${BODY}`;
}
function fixture(source = share()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-cli-')); const file = path.join(dir, 'TASK.md'); fs.writeFileSync(file, source); return file;
}
// 설치 사본(tools/task/index.js)이 아니라 engine/을 직접 대상으로 삼는다. 덕분에 이 저장소에서
// 자기설치 없이 테스트가 돈다(엔진이 어디에 설치되든 테스트는 canonical 소스를 검증한다).
const TASK_CLI = path.resolve(__dirname, '..', 'index.js');
function cli(file, args, input, cwd) {
  return spawnSync(process.execPath, [TASK_CLI, ...args], { cwd: cwd || process.cwd(), env: { ...process.env, TASK_STATE_FILE: file }, input, encoding: 'utf8' });
}
module.exports = { BODY, share, fixture, cli, TASK_CLI };
