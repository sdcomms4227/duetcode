const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync, spawn } = require('node:child_process');
const { assertSafeProfile, assertSafeBaseUrl, lookup, planCheck, summarize, runVerify, PRODUCTION_PROFILE } = require('../verify');
const { share, TASK_CLI } = require('./helpers');

// 임시 HTTP 서버. 검증 하니스는 실제 요청을 보내므로 목이 아니라 진짜 서버를 상대한다.
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` }));
  });
}
const close = (server) => new Promise((resolve) => server.close(resolve));
const base = (baseUrl) => new URL(baseUrl);

function config(baseUrl, overrides = {}) {
  return { profile: 'dev', baseUrl, checks: [{ name: 'health', path: '/health' }], ...overrides };
}

// --- 프로파일 게이트 -------------------------------------------------------

test('운영으로 읽히는 프로파일은 화이트리스트에 넣어도 거부한다', () => {
  // 이 검사는 설정으로 완화할 수 없는 유일한 규칙이다. 운영 환경 검증은 사람 게이트이기 때문이다.
  for (const profile of ['prod', 'production', 'prd', 'live', 'release', 'main', 'app-prod', 'us_production_1']) {
    assert.ok(PRODUCTION_PROFILE.test(profile), `${profile}은 운영으로 판정되어야 한다`);
    assert.throws(
      () => assertSafeProfile({ profile, allowedProfiles: [profile] }),
      /운영으로 읽히는 프로파일/,
      `${profile}: allowedProfiles에 넣어도 거부해야 한다`
    );
  }
});

test('운영처럼 보이지만 아닌 이름은 통과한다', () => {
  // 과탐지도 결함이다. 'reproduce'가 'prod'를 포함한다고 막으면 정상 설정이 쓰이지 못한다.
  for (const profile of ['dev', 'local', 'test', 'reproduce', 'product-catalog-dev']) {
    assert.ok(!PRODUCTION_PROFILE.test(profile), `${profile}은 운영이 아니어야 한다`);
  }
  assert.equal(assertSafeProfile({ profile: 'dev' }), 'dev');
  assert.equal(assertSafeProfile({ profile: 'reproduce', allowedProfiles: ['reproduce'] }), 'reproduce');
});

test('화이트리스트 밖의 프로파일은 거부한다', () => {
  assert.throws(() => assertSafeProfile({ profile: 'staging' }), /허용되지 않은 프로파일/);
  assert.equal(assertSafeProfile({ profile: 'staging', allowedProfiles: ['staging'] }), 'staging');
  assert.throws(() => assertSafeProfile({}), /profile 문자열이 필요/);
});

// --- baseUrl 게이트 --------------------------------------------------------

test('기본은 루프백만 허용하고, 원격은 명시적으로 켜야 한다', () => {
  // baseUrl 한 줄 오타로 남의 서버에 요청이 나가는 것을 막는다.
  assert.throws(() => assertSafeBaseUrl({ baseUrl: 'http://example.com' }), /루프백 호스트가 아닙니다/);
  assert.equal(assertSafeBaseUrl({ baseUrl: 'http://example.com', allowRemoteHost: true }).hostname, 'example.com');
  assert.equal(assertSafeBaseUrl({ baseUrl: 'http://127.0.0.1:8080' }).hostname, '127.0.0.1');
  assert.throws(() => assertSafeBaseUrl({ baseUrl: 'file:///etc/passwd' }), /http\/https/);
  assert.throws(() => assertSafeBaseUrl({ baseUrl: 'not a url' }), /유효한 URL이 아닙니다/);
});

// --- 비파괴 원칙 -----------------------------------------------------------

test('GET/HEAD 외의 메서드와 요청 본문은 설정으로도 허용되지 않는다', () => {
  const b = base('http://127.0.0.1:1');
  const cfg = config('http://127.0.0.1:1');
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.throws(() => planCheck(cfg, b, { name: 'x', path: '/x', method }, 0), /비파괴 검증은 GET\/HEAD만/);
  }
  assert.throws(() => planCheck(cfg, b, { name: 'x', path: '/x', body: '{}' }, 0), /본문을 넣을 수 없습니다/);
  assert.equal(planCheck(cfg, b, { name: 'x', path: '/x', method: 'head' }, 0).method, 'HEAD');
});

test('path가 baseUrl 밖을 가리키면 거부한다', () => {
  // '//evil.example'은 프로토콜 상대 URL이라 origin이 통째로 바뀐다.
  const b = base('http://127.0.0.1:1');
  assert.throws(() => planCheck(config('http://127.0.0.1:1'), b, { name: 'x', path: '//evil.example/steal' }, 0), /baseUrl 밖을 가리킵니다/);
  assert.throws(() => planCheck(config('http://127.0.0.1:1'), b, { name: 'x', path: 'relative' }, 0), /'\/'로 시작하는 문자열/);
});

// --- 설정 누락 → 해당 항목만 건너뜀 ---------------------------------------

test('설정이 없는 항목만 건너뛰고 나머지는 실행한다', async () => {
  // "설정이 없다"와 "기능이 깨졌다"를 구분하는 것이 이 규칙의 목적이다.
  const seen = [];
  const { server, baseUrl } = await serve((req, res) => { seen.push(req.url); res.writeHead(200).end('ok'); });
  try {
    const report = await runVerify({
      config: config(baseUrl, {
        records: { readOnlyRecordId: 'replace-locally' }, // 자리표시자 = 미설정
        checks: [
          { name: 'health', path: '/health' },
          { name: 'record', path: '/records/{records.readOnlyRecordId}' },
          { name: 'env-gated', path: '/x', requires: ['env:DUET_VERIFY_TEST_ABSENT'] }
        ]
      })
    });
    assert.equal(report.status, 'PARTIAL', '누락은 FAILED가 아니라 PARTIAL이다');
    assert.equal(report.failedCount, 0);
    assert.deepEqual(report.results.map((r) => r.outcome), ['PASSED', 'SKIPPED', 'SKIPPED']);
    assert.match(report.results[1].reason, /설정 누락: records\.readOnlyRecordId/);
    assert.deepEqual(seen, ['/health'], '건너뛴 검사는 요청을 보내지 않는다');
  } finally {
    await close(server);
  }
});

test('자리표시자·빈 문자열·없는 키는 모두 미설정으로 본다', () => {
  const cfg = { records: { a: 'replace-locally', b: '', c: 'real' } };
  assert.equal(lookup(cfg, 'records.a'), null);
  assert.equal(lookup(cfg, 'records.b'), null);
  assert.equal(lookup(cfg, 'records.c'), 'real');
  assert.equal(lookup(cfg, 'records.missing'), null);
  assert.equal(lookup(cfg, 'nothing.at.all'), null);
});

// --- 판정 -----------------------------------------------------------------

test('실패가 하나라도 있으면 FAILED이고 건수를 센다', async () => {
  const { server, baseUrl } = await serve((req, res) => {
    if (req.url === '/health') res.writeHead(200).end('ok');
    else res.writeHead(500).end('boom');
  });
  try {
    const report = await runVerify({
      config: config(baseUrl, { checks: [{ name: 'health', path: '/health' }, { name: 'a', path: '/a' }, { name: 'b', path: '/b' }] })
    });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.failedCount, 2);
    assert.match(report.results[1].reason, /상태 500 \(기대: 200\)/);
  } finally {
    await close(server);
  }
});

test('검증-실패 프로빙: 기대 상태가 200이 아니어도 된다', async () => {
  // 비파괴로 확인할 수 있는 것 중 하나가 "인증 없이는 거부되는가"다. 401을 기대값으로 쓴다.
  const { server, baseUrl } = await serve((req, res) => {
    if (req.url === '/private') res.writeHead(401).end();
    else res.writeHead(200).end('ok');
  });
  try {
    const report = await runVerify({
      config: config(baseUrl, { checks: [{ name: 'auth-required', path: '/private', expectStatus: 401 }, { name: 'either', path: '/health', expectStatus: [200, 204] }] })
    });
    assert.equal(report.status, 'PASSED');
    assert.equal(report.failedCount, 0);
  } finally {
    await close(server);
  }
});

test('실행된 검사가 0건이면 PASSED가 아니라 PARTIAL이다', () => {
  // "아무것도 안 했다"가 "다 통과했다"로 읽히면 하니스가 게이트가 아니라 우회로가 된다.
  assert.deepEqual(summarize([{ outcome: 'SKIPPED' }]), { status: 'PARTIAL', failedCount: 0 });
  assert.deepEqual(summarize([]), { status: 'PARTIAL', failedCount: 0 });
  assert.deepEqual(summarize([{ outcome: 'PASSED' }]), { status: 'PASSED', failedCount: 0 });
  assert.deepEqual(summarize([{ outcome: 'PASSED' }, { outcome: 'SKIPPED' }]), { status: 'PARTIAL', failedCount: 0 });
  assert.deepEqual(summarize([{ outcome: 'PASSED' }, { outcome: 'FAILED' }, { outcome: 'SKIPPED' }]), { status: 'FAILED', failedCount: 1 });
});

test('연결할 수 없는 대상은 FAILED다(무응답을 통과로 해석하지 않는다)', async () => {
  const { server, baseUrl } = await serve((req, res) => res.writeHead(200).end());
  await close(server); // 방금 닫은 포트 = 아무도 듣지 않는 포트
  const report = await runVerify({ config: config(baseUrl) });
  assert.equal(report.status, 'FAILED');
  assert.equal(report.failedCount, 1);
  assert.match(report.results[0].reason, /요청 실패/);
});

// --- 최대 실행 시간 --------------------------------------------------------

test('최대 실행 시간을 넘기면 남은 검사는 건너뜀이 아니라 실패다', async () => {
  // timeout을 성공이나 미실행으로 해석하면 "느려서 못 끝낸 것"이 조용히 통과한다.
  const { server, baseUrl } = await serve((req, res) => setTimeout(() => res.writeHead(200).end(), 300));
  try {
    const report = await runVerify({
      config: config(baseUrl, { maxDurationMs: 120, checks: [{ name: 'slow', path: '/slow' }, { name: 'never', path: '/never' }] })
    });
    assert.equal(report.status, 'FAILED');
    assert.equal(report.failedCount, 2);
    assert.match(report.results[1].reason, /최대 실행 시간/);
  } finally {
    await close(server);
  }
});

test('개별 검사 타임아웃은 그 검사만 실패시킨다', async () => {
  const { server, baseUrl } = await serve((req, res) => {
    if (req.url === '/fast') res.writeHead(200).end();
    else setTimeout(() => res.writeHead(200).end(), 2000);
  });
  try {
    const report = await runVerify({
      config: config(baseUrl, { checkTimeoutMs: 150, checks: [{ name: 'slow', path: '/slow' }, { name: 'fast', path: '/fast' }] })
    });
    assert.equal(report.failedCount, 1);
    assert.equal(report.results[1].outcome, 'PASSED');
  } finally {
    await close(server);
  }
});

// --- 서버 소유권 -----------------------------------------------------------

test('하니스가 띄운 서버만 종료하고, 실패 경로에서도 정리한다', async () => {
  // 소유권 없는 프로세스를 죽이지 않는 것이 핵심이다. 여기서는 우리가 띄운 것을 확실히 죽이는 쪽을 본다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-verify-server-'));
  const script = path.join(dir, 'server.js');
  // 설정의 baseUrl은 서버를 띄우기 전에 정해져야 하므로, 빈 포트를 하나 잡았다 놓아 번호를 얻는다.
  const probe = await serve(() => {});
  const port = new URL(probe.baseUrl).port;
  await close(probe.server);
  fs.writeFileSync(script, [
    "const http = require('node:http');",
    "http.createServer((req, res) => { if (req.url === '/fail') { res.writeHead(500).end(); } else { res.writeHead(200).end('ok'); } })",
    `  .listen(${port}, '127.0.0.1');`
  ].join('\n'));

  try {
    const report = await runVerify({
      config: config(`http://127.0.0.1:${port}`, {
        server: { command: process.execPath, args: [script], readyPath: '/health', readyTimeoutMs: 10_000 },
        checks: [{ name: 'health', path: '/health' }, { name: 'fail', path: '/fail' }]
      })
    });
    assert.equal(report.status, 'FAILED', '검사는 실패했지만');
    // 리포트는 sha256으로 해시돼 증거로 남는다. 그래서 "정리했다"가 아니라 "종료를 확인했다"만 적는다.
    assert.equal(report.spawnedServer.exited, true, '실패 경로에서도 우리가 띄운 서버는 정리되고, 종료가 확인되어야 한다');
    assert.equal(report.spawnedServer.terminated, true, '우리가 종료를 시도했다는 사실도 남는다');
    // 실제로 죽었는지 확인한다 — 보고만 하고 살려두면 다음 실행이 포트 충돌로 깨진다.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await runVerify({ config: config(`http://127.0.0.1:${port}`) }).catch((e) => e);
    assert.equal(after.status, 'FAILED', '서버가 죽었으므로 같은 포트 요청은 실패해야 한다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('서버가 손자 프로세스로 듣고 있어도 종료된다', async () => {
  // 실제 형태는 `npm run dev` → node다. 부모만 죽이면 손자가 포트를 물고 남아 다음 실행이 깨진다.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `duet-verify-tree-${process.pid}-`));
  const probe = await serve(() => {});
  const port = new URL(probe.baseUrl).port;
  await close(probe.server);
  try {
    const inner = path.join(dir, 'inner.js');
    fs.writeFileSync(inner, `require('node:http').createServer((q, s) => s.writeHead(200).end('ok')).listen(${port}, '127.0.0.1');`);
    const outer = path.join(dir, 'outer.js');
    fs.writeFileSync(outer, `
      require('node:child_process').spawn(process.execPath, [${JSON.stringify(inner)}], { stdio: 'ignore' });
      setInterval(() => {}, 1000);
    `);
    const report = await runVerify({
      config: config(`http://127.0.0.1:${port}`, {
        server: { command: process.execPath, args: [outer], readyPath: '/health', readyTimeoutMs: 15_000 }
      })
    });
    assert.equal(report.status, 'PASSED', '손자가 띄운 서버로도 검사는 통과한다');
    assert.equal(report.spawnedServer.exited, true);
    // 포트가 실제로 풀렸는지 본다 — 손자가 남아 있으면 여기서 드러난다.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const after = await runVerify({ config: config(`http://127.0.0.1:${port}`, { checkTimeoutMs: 1000 }) });
    assert.equal(after.status, 'FAILED', '트리가 죽었으므로 같은 포트는 더 이상 응답하지 않아야 한다');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('서버가 준비되기 전에 죽으면 그 사실을 알린다', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `duet-verify-dead-${process.pid}-`));
  try {
    const script = path.join(dir, 'dies.js');
    fs.writeFileSync(script, 'process.exit(3);');
    await assert.rejects(
      () => runVerify({
        config: config('http://127.0.0.1:1', { server: { command: process.execPath, args: [script], readyTimeoutMs: 5000 } })
      }),
      /검증 서버가 준비되기 전에 종료되었습니다/
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// --- CLI 통합 --------------------------------------------------------------

function repo(verifyConfig, taskSource = share()) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-verify-cli-'));
  fs.mkdirSync(path.join(dir, '.duet'), { recursive: true });
  if (verifyConfig) fs.writeFileSync(path.join(dir, '.duet', 'verify.json'), JSON.stringify(verifyConfig, null, 2));
  const file = path.join(dir, 'TASK.md');
  fs.writeFileSync(file, taskSource);
  return { dir, file };
}
const cliEnv = (dir, file) => ({ ...process.env, TASK_STATE_FILE: file, DUET_REPO_ROOT: dir });
// 서버가 필요 없는(요청 이전에 끝나는) 검사용. spawnSync는 부모 이벤트 루프를 멈추므로,
// 이 프로세스에서 띄운 테스트 서버를 상대해야 할 때는 절대 쓰면 안 된다 — 서버가 응답할 수 없어
// 모든 검사가 타임아웃으로 실패하고, 그 실패가 "기대한 FAILED"와 구분되지 않는다.
function runCliSync(dir, file, args) {
  return spawnSync(process.execPath, [TASK_CLI, ...args], { env: cliEnv(dir, file), encoding: 'utf8' });
}
// 테스트 서버를 상대하는 검사용. 부모 루프를 살려 두어야 서버가 응답한다.
function runCli(dir, file, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TASK_CLI, ...args], { env: cliEnv(dir, file) });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

test('verify는 REVIEW에서만 허용된다', () => {
  const { dir, file } = repo(config('http://127.0.0.1:1'), share().replace('status: REVIEW', 'status: IMPLEMENTING'));
  try {
    const result = runCliSync(dir, file, ['verify']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /verify는 REVIEW에서만/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify는 결과를 verification에 쓰고 증거를 남긴다', async () => {
  const { server, baseUrl } = await serve((req, res) => res.writeHead(200).end('ok'));
  const { dir, file } = repo(config(baseUrl));
  try {
    const result = await runCli(dir, file, ['verify']);
    assert.equal(result.status, 0, result.stderr);
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /status: PASSED/);
    assert.match(written, /exitCode: 0/);
    assert.match(written, /command: duet-task verify \(profile=dev/);
    // 증거 해시는 출력한 리포트의 해시여야 한다 — 자기 신고가 아니라 실행 결과다.
    const report = JSON.parse(result.stdout);
    const expected = require('node:crypto').createHash('sha256').update(JSON.stringify(report, null, 2)).digest('hex');
    assert.match(written, new RegExp(`outputSha256: ${expected}`));
    // 기록된 TASK.md는 반드시 lint를 통과해야 한다(하니스가 자기 자신을 무효 상태로 만들면 안 된다).
    assert.equal((await runCli(dir, file, ['lint'])).status, 0);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('검증 실패는 exit 1이지만 결과는 기록된다', async () => {
  const { server, baseUrl } = await serve((req, res) => res.writeHead(503).end());
  const { dir, file } = repo(config(baseUrl));
  try {
    const result = await runCli(dir, file, ['verify']);
    assert.equal(result.status, 1, '실패를 exit 0으로 끝내면 스크립트가 실패를 못 본다');
    const written = fs.readFileSync(file, 'utf8');
    assert.match(written, /status: FAILED/);
    assert.match(written, /failedCount: 1/);
    assert.match(written, /exitCode: 1/);
    assert.equal((await runCli(dir, file, ['lint'])).status, 0, '실패 기록도 유효한 상태여야 한다');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('verify 결과는 PARTIAL 승인 없이 DONE으로 갈 수 없다', async () => {
  // 하니스가 PARTIAL을 썼다는 이유로 DONE 게이트가 느슨해지면 안 된다 — 승인 경로는 그대로 사람 게이트다.
  const { server, baseUrl } = await serve((req, res) => res.writeHead(200).end('ok'));
  const { dir, file } = repo(config(baseUrl, {
    checks: [{ name: 'health', path: '/health' }, { name: 'gated', path: '/x', requires: ['env:DUET_VERIFY_TEST_ABSENT'] }]
  }));
  try {
    assert.equal((await runCli(dir, file, ['verify'])).status, 1);
    assert.match(fs.readFileSync(file, 'utf8'), /status: PARTIAL/);
    const done = await runCli(dir, file, ['set', 'status=DONE']);
    assert.equal(done.status, 1);
    assert.match(done.stderr, /DONE 검증 조건/);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('설정 파일이 없으면 무엇을 만들어야 하는지 알린다', () => {
  const { dir, file } = repo(null);
  try {
    const result = runCliSync(dir, file, ['verify']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /검증 설정이 없습니다/);
    // 샘플 경로는 실제로 존재하는 파일을 가리켜야 한다. 대상 저장소에서는 node_modules 아래이므로
    // 'templates/...' 같은 상대 경로를 그대로 안내하면 그 저장소에 없는 경로를 알려주게 된다.
    const sample = result.stderr.match(/copy\s*:\s*(.+)/)?.[1]?.trim();
    assert.ok(sample && fs.existsSync(sample), `안내한 샘플 경로가 실재해야 한다: ${sample}`);
    // 디렉터리째로 없는 경우가 흔하므로 mkdir 대상도 함께 알려준다.
    const mkdirTarget = result.stderr.match(/mkdir\s*:\s*(.+)/)?.[1]?.trim();
    assert.ok(mkdirTarget && mkdirTarget.endsWith('.duet'), `mkdir 대상을 알려야 한다: ${mkdirTarget}`);
    // 설정이 없다고 verification을 건드리면 안 된다(원래 값 보존).
    assert.match(fs.readFileSync(file, 'utf8'), /updated: 2026-07-14T00:00:00Z/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('운영 프로파일 설정은 요청을 한 건도 보내기 전에 거부한다', async () => {
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => { requests += 1; res.writeHead(200).end(); });
  const { dir, file } = repo(config(baseUrl, { profile: 'production', allowedProfiles: ['production'] }));
  try {
    const result = await runCli(dir, file, ['verify']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /운영으로 읽히는 프로파일/);
    assert.equal(requests, 0, '거부는 요청 이전이어야 한다');
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('파괴적 메서드가 섞여 있으면 앞선 검사도 실행하지 않는다', async () => {
  // 계획을 전부 세운 뒤 실행한다. 절반 보내고 실패하면 "비파괴"가 절반만 지켜진 셈이 된다.
  let requests = 0;
  const { server, baseUrl } = await serve((req, res) => { requests += 1; res.writeHead(200).end(); });
  const { dir, file } = repo(config(baseUrl, {
    checks: [{ name: 'ok', path: '/health' }, { name: 'bad', path: '/delete', method: 'DELETE' }]
  }));
  try {
    const result = await runCli(dir, file, ['verify']);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /비파괴 검증은 GET\/HEAD만/);
    assert.equal(requests, 0);
  } finally {
    await close(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
