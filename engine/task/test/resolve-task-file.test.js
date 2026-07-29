const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { resolveTaskFile } = require('../lib');
const { share, TASK_CLI } = require('./helpers');

// TASK_STATE_FILE 없이(= 사람이 duet-task를 직접 부르는 경로) CLI를 돌린다. 헬퍼의 cli()는 항상
// TASK_STATE_FILE을 주므로 여기서만 쓰는 별도 실행기가 필요하다.
function bare(cwd, args) {
  const env = { ...process.env };
  delete env.TASK_STATE_FILE;
  delete env.DUET_REPO_ROOT;
  return spawnSync(process.execPath, [TASK_CLI, ...args], { cwd, env, encoding: 'utf8' });
}

function repo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-resolve-')));
  fs.writeFileSync(path.join(dir, 'TASK.md'), share());
  fs.mkdirSync(path.join(dir, 'src', 'nested'), { recursive: true });
  return dir;
}

test('TASK_STATE_FILE이 있으면 그대로 쓴다(명시 지정이 최우선)', () => {
  assert.equal(resolveTaskFile({ TASK_STATE_FILE: '/tmp/elsewhere/TASK.md' }, '/somewhere'), '/tmp/elsewhere/TASK.md');
});

test('cwd의 TASK.md가 저장소 루트보다 우선한다(기존 동작 보존)', () => {
  const dir = repo();
  try {
    const nested = path.join(dir, 'src');
    fs.writeFileSync(path.join(nested, 'TASK.md'), share());
    assert.equal(resolveTaskFile({ DUET_REPO_ROOT: dir }, nested), path.join(nested, 'TASK.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cwd에 없으면 저장소 루트의 TASK.md로 폴백한다', () => {
  const dir = repo();
  try {
    const nested = path.join(dir, 'src', 'nested');
    assert.equal(resolveTaskFile({ DUET_REPO_ROOT: dir }, nested), path.join(dir, 'TASK.md'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('서브디렉터리에서 실행해도 저장소의 TASK.md를 읽는다', () => {
  // 예전에는 cwd 상대 'TASK.md' 하나뿐이라 서브디렉터리 호출이 실패했다 — 같은 저장소에서
  // duet-handoff는 찾는데 duet-task는 못 찾아 두 엔진의 동작이 갈려 있었다.
  const dir = repo();
  try {
    const run = spawnSync(process.execPath, [TASK_CLI, 'show'], {
      cwd: path.join(dir, 'src', 'nested'),
      env: { ...process.env, TASK_STATE_FILE: '', DUET_REPO_ROOT: dir },
      encoding: 'utf8'
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).id, 'task-test');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('어디에도 없으면 찾은 경로와 해결 방법을 알려준다', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'task-missing-')));
  try {
    const run = bare(dir, ['show']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /TASK\.md를 찾을 수 없습니다/);
    assert.match(run.stderr, /TASK_STATE_FILE/);
    // 사용자가 선 곳을 가리켜야 어디를 봤는지 알 수 있다.
    assert.ok(run.stderr.includes(path.join(dir, 'TASK.md')), run.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
