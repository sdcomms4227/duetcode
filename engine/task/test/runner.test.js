const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// run.js 자체의 계약을 고정한다. 이 러너가 조용히 아무것도 실행하지 않으면 CI가 초록불인데
// 테스트는 하나도 돌지 않는 상태가 되므로, "0개는 실패"와 "실패 전파"를 회귀로 묶어 둔다.
const RUNNER = path.join(__dirname, 'run.js');

function sandbox(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-runner-'));
  fs.copyFileSync(RUNNER, path.join(dir, 'run.js'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  return dir;
}
function runRunner(dir) {
  return spawnSync(process.execPath, [path.join(dir, 'run.js')], { encoding: 'utf8' });
}

test('테스트 파일이 0개면 통과가 아니라 실패로 끝낸다', () => {
  const dir = sandbox({});
  try {
    const result = runRunner(dir);
    assert.notEqual(result.status, 0, '대상이 없으면 exit 0이면 안 된다');
    assert.match(result.stderr, /실행할 테스트 파일이 없습니다/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('실패한 테스트의 exit code를 전파한다', () => {
  const dir = sandbox({ 'fail.test.js': "require('node:test').test('실패', () => { throw new Error('boom'); });\n" });
  try {
    assert.notEqual(runRunner(dir).status, 0, '하위 테스트 실패가 러너 exit code에 반영되어야 한다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('*.test.js만 실행하고 헬퍼 모듈은 건드리지 않는다', () => {
  const dir = sandbox({
    'ok.test.js': "require('node:test').test('통과', () => {});\n",
    'helpers.js': "throw new Error('헬퍼가 테스트로 실행됐다');\n"
  });
  try {
    const result = runRunner(dir);
    assert.equal(result.status, 0, `헬퍼가 실행됐거나 테스트가 실패했다: ${result.stderr}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
