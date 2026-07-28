const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { issueSyncMarker, issueSyncBody, syncIssueComment } = require('../lib');
const { share, fixture, TASK_CLI } = require('./helpers');

const TASK_ID = 'task-test';
const marker = issueSyncMarker(TASK_ID);
const data = { id: TASK_ID, status: 'CANCELLED', verification: null, closure: { type: 'CANCELLED', reason: '중단' } };

// gh 호출을 기록하는 스텁. 목록 조회는 REST 응답(JSON 배열 문자열)을 돌려주고, 쓰기 호출은 빈 문자열을 돌려준다.
function ghStub(comments) {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    if (args[0] === 'api' && !args.includes('-X')) return JSON.stringify(comments);
    return '';
  };
  return { gh, calls };
}

// gh가 PATH에서 발견되지 않는 환경. gh가 호출됐는지 여부를 stderr로 관찰하기 위한 장치다.
function cliWithoutGh(file, args) {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-gh-'));
  try {
    return spawnSync(process.execPath, [TASK_CLI, ...args], {
      cwd: process.cwd(), encoding: 'utf8',
      env: { ...process.env, TASK_STATE_FILE: file, PATH: emptyDir, Path: emptyDir }
    });
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
}

test('본문에 Task 식별 마커를 넣어 이후 실행이 자기 코멘트를 찾을 수 있게 한다', () => {
  const body = issueSyncBody(data);
  assert.ok(body.startsWith(marker));
  assert.match(body, /Status: CANCELLED/);
});

test('기존 동기화 코멘트가 없으면 새로 등록한다', () => {
  const { gh, calls } = ghStub([{ id: 1, body: '사람이 남긴 무관한 코멘트' }]);
  const result = syncIssueComment(data, 613, gh);
  assert.equal(result.action, 'created');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].slice(0, 3), ['issue', 'comment', '613']);
});

test('기존 동기화 코멘트가 있으면 새로 달지 않고 갱신한다(재시도 중복 방지)', () => {
  const { gh, calls } = ghStub([{ id: 1, body: '무관' }, { id: 42, body: `${marker}\nTask: ${TASK_ID}\nStatus: DESIGN` }]);
  const result = syncIssueComment(data, 613, gh);
  assert.equal(result.action, 'updated');
  assert.equal(result.id, 42);
  assert.equal(calls.length, 2);
  assert.equal(calls[1][1], 'repos/{owner}/{repo}/issues/comments/42');
  assert.ok(calls[1].includes('PATCH'));
  // 새 코멘트 등록 경로는 타지 않아야 한다.
  assert.equal(calls.some((call) => call[0] === 'issue'), false);
});

test('다른 Task의 마커는 갱신 대상으로 삼지 않는다', () => {
  const { gh, calls } = ghStub([{ id: 9, body: `${issueSyncMarker('other-task')}\nStatus: DONE` }]);
  assert.equal(syncIssueComment(data, 613, gh).action, 'created');
  assert.deepEqual(calls[1].slice(0, 2), ['issue', 'comment']);
});

test('동기화 코멘트가 여러 개면 임의 갱신 대신 사람에게 넘긴다', () => {
  const { gh, calls } = ghStub([{ id: 1, body: marker }, { id: 2, body: marker }]);
  assert.throws(() => syncIssueComment(data, 613, gh), /2개/);
  assert.equal(calls.length, 1); // 목록 조회만 하고 쓰기는 하지 않았다
});

test('목록 조회 결과를 해석하지 못하면 게시하지 않는다(fail-closed)', () => {
  const calls = [];
  const gh = (args) => { calls.push(args); return '<html>rate limited</html>'; };
  assert.throws(() => syncIssueComment(data, 613, gh), /중복 게시/);
  assert.equal(calls.length, 1);
});

test('무효한 TASK.md는 gh를 호출하기 전에 거부한다', () => {
  // lint가 외부 쓰기보다 앞서지 않으면 무효한 상태가 Issue에 게시된 뒤에야 걸린다.
  const source = share().replace('issue: null', 'issue: 613').replace('**다음 담당자**: Claude', '**다음 담당자**: 미정');
  const result = cliWithoutGh(fixture(source), ['issue-sync']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /다음 담당자/);
  assert.doesNotMatch(result.stderr, /ENOENT|gh/); // gh를 부르지 않았다
});

test('유효한 TASK.md에서는 lint를 통과해 gh 호출까지 진행한다', () => {
  // 위 테스트가 "lint가 항상 먼저 실패해서" 통과하는 게 아님을 보인다.
  const result = cliWithoutGh(fixture(share().replace('issue: null', 'issue: 613')), ['issue-sync']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT|spawnSync/);
});
