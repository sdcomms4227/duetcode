const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { resolveOnPath, resolveSpawn, quoteForCmd, terminateProcessTree } = require('../lib');

let counter = 0;
function fakeBin(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `duet-bin-${process.pid}-${counter++}-`));
  for (const name of names) fs.writeFileSync(path.join(dir, name), '@echo off\r\n');
  return dir;
}
const env = (dir) => ({ PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' });

// --- PATH 해석 -------------------------------------------------------------

test('PATHEXT 순서대로 실행 파일을 찾는다', () => {
  const dir = fakeBin(['tool.CMD', 'tool.EXE']);
  try {
    // .EXE가 .CMD보다 앞선 PATHEXT이므로 .EXE가 이긴다.
    assert.equal(resolveOnPath('tool', env(dir)), path.join(dir, 'tool.EXE'));
    assert.equal(resolveOnPath('없는것', env(dir)), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- resolveSpawn: 플랫폼별 동작 -------------------------------------------

test('win32가 아니면 아무것도 바꾸지 않는다', () => {
  const dir = fakeBin(['npm.CMD']);
  try {
    const r = resolveSpawn('npm', ['run', 'dev'], env(dir), 'linux');
    assert.equal(r.executable, 'npm');
    assert.deepEqual(r.args, ['run', 'dev']);
    assert.deepEqual(r.options, {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('win32에서 .cmd는 cmd.exe로 감싸고 인자를 인용한다', () => {
  // .cmd는 shell 없이 spawn할 수 없다(Node가 EINVAL로 막는다). shell: true는 인자를 이어 붙이기만 해서
  // 공백 있는 경로가 깨진다. 그래서 cmd.exe를 직접 부르고 인용을 우리가 만든다.
  const dir = fakeBin(['npm.CMD']);
  try {
    const r = resolveSpawn('npm', ['run', 'dev server'], { ...env(dir), ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32');
    assert.equal(r.executable, 'C:\\Windows\\system32\\cmd.exe');
    assert.equal(r.args[0], '/d');
    assert.equal(r.args[1], '/s');
    assert.equal(r.args[2], '/c');
    // 전체를 한 번 감싸고, 공백 있는 인자는 개별 인용된다.
    assert.match(r.args[3], /^".*"$/, '명령줄 전체가 인용되어야 한다');
    assert.ok(r.args[3].includes('"run"') === false, '공백 없는 인자는 인용하지 않는다');
    assert.ok(r.args[3].includes('"dev server"'), '공백 있는 인자는 인용한다');
    assert.equal(r.options.windowsVerbatimArguments, true, 'Node가 인용을 덧씌우지 않게 해야 한다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('win32에서 .exe·경로 지정·미해석은 그대로 둔다', () => {
  // 바꿀 이유가 없는 경로는 건드리지 않는다 — 핸드오프의 codex.exe 경로가 여기에 해당한다.
  const dir = fakeBin(['tool.EXE']);
  try {
    const resolved = resolveSpawn('tool', [], env(dir), 'win32');
    assert.equal(resolved.executable, path.join(dir, 'tool.EXE'));
    assert.deepEqual(resolved.options, {});

    const absolute = resolveSpawn('C:\\Program Files\\nodejs\\node.exe', ['-v'], env(dir), 'win32');
    assert.equal(absolute.executable, 'C:\\Program Files\\nodejs\\node.exe');
    assert.deepEqual(absolute.options, {});

    // PATH에 없는 이름은 원래 값으로 남긴다 — spawn이 ENOENT로 알려주게 둔다.
    const missing = resolveSpawn('전혀없는명령', [], env(dir), 'win32');
    assert.equal(missing.executable, '전혀없는명령');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('cmd 인용은 내부 인용부호를 중복으로 이스케이프한다', () => {
  // cmd는 \" 를 모른다. 백슬래시로 이스케이프하면 명령줄이 깨진다(실측으로 확인한 실패 원인).
  assert.equal(quoteForCmd('plain'), 'plain');
  assert.equal(quoteForCmd('has space'), '"has space"');
  assert.equal(quoteForCmd('a"b'), '"a""b"');
  assert.equal(quoteForCmd('a&b'), '"a&b"');
});

// --- 실제 실행 확인(win32에서만 의미가 있다) ------------------------------

test('win32에서 .cmd를 실제로 실행하고 인자가 보존된다', (t) => {
  if (process.platform !== 'win32') return t.skip('win32 전용');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `duet-cmd-${process.pid}-`));
  try {
    // 인자를 그대로 되돌려주는 .cmd. 공백과 & 를 포함한 인자가 살아 오는지 본다.
    const script = path.join(dir, 'echoargs.cmd');
    fs.writeFileSync(script, '@echo off\r\nnode -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n');
    const invocation = resolveSpawn(script, ['a b', 'c&d']);
    const run = spawnSync(invocation.executable, invocation.args, { encoding: 'utf8', windowsHide: true, ...invocation.options });
    assert.equal(run.error, undefined);
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout.trim()), ['a b', 'c&d']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- 프로세스 트리 종료 ----------------------------------------------------

test('terminateProcessTree는 손자 프로세스까지 죽인다', async () => {
  // 부모만 죽이면 실제로 일하는 손자가 남는다. 이 함수가 dispatch(codex)와 verify(스모크 서버)
  // 양쪽에서 쓰이는 이유다.
  //
  // **플랫폼마다 방법이 다르고, POSIX는 호출자의 협력이 필요하다.** Windows는 taskkill /T가 트리를
  // 처리하지만, POSIX에는 "자손 전체"를 가리키는 수단이 없어 프로세스 그룹을 죽여야 한다. 그러려면
  // 자식이 detached로 띄워져 그룹 리더여야 하고, 호출자가 group: true로 그 사실을 알려야 한다.
  // v0.3.1이 이 구분 없이 Windows 경로만 구현해 Linux에서 손자를 남겼고, CI가 그것을 잡았다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `duet-tree-${process.pid}-`));
  try {
    const grandchild = path.join(dir, 'grandchild.js');
    const marker = path.join(dir, 'alive.txt');
    fs.writeFileSync(grandchild, `
      const fs = require('node:fs');
      setInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50);
    `);
    const parent = path.join(dir, 'parent.js');
    fs.writeFileSync(parent, `
      require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `);
    // POSIX에서는 detached로 띄워야 그룹 종료가 가능하다(verify의 startServer가 하는 것과 같다).
    const group = process.platform !== 'win32';
    const child = spawn(process.execPath, [parent], { stdio: 'ignore', windowsHide: true, detached: group });
    // 손자가 실제로 살아 있음을 확인한 뒤에 죽인다(살아 있지 않았다면 이 테스트는 아무것도 증명하지 못한다).
    for (let i = 0; i < 60 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
    assert.ok(fs.existsSync(marker), '손자가 먼저 살아 있어야 한다');

    const result = terminateProcessTree(child, { group });
    assert.equal(result.attempted, true);
    if (group) assert.equal(result.groupKilled, true, 'POSIX에서는 그룹 종료가 실제로 이뤄져야 한다');
    await new Promise((r) => setTimeout(r, 700));

    // marker의 mtime이 더 이상 갱신되지 않으면 손자가 죽은 것이다.
    const first = fs.statSync(marker).mtimeMs;
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(fs.statSync(marker).mtimeMs, first, '손자가 계속 쓰고 있으면 트리 종료가 안 된 것이다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pid가 없으면 시도하지 않는다', () => {
  assert.deepEqual(terminateProcessTree(null), { attempted: false, taskkillExitCode: null, groupKilled: false });
  assert.deepEqual(terminateProcessTree({}), { attempted: false, taskkillExitCode: null, groupKilled: false });
});

test('group을 주지 않으면 POSIX에서 그룹 종료를 시도하지 않는다', async (t) => {
  if (process.platform === 'win32') return t.skip('POSIX 전용 — Windows는 taskkill /T를 쓴다');
  // 추측으로 kill(-pid)를 부르면 pid가 우연히 다른 그룹의 pgid와 겹칠 때 남의 그룹을 죽인다.
  // CI에서라면 러너 자신이 대상이 될 수 있다. 그래서 협력하지 않은 호출자에게는 시도하지 않는다.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  try {
    const result = terminateProcessTree(child);
    assert.equal(result.attempted, true);
    assert.equal(result.groupKilled, false, 'group 없이는 그룹 종료를 시도하지 않는다');
  } finally {
    try { child.kill('SIGKILL'); } catch { /* 이미 죽었다 */ }
  }
});
