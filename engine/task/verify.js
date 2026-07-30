// `task verify` — 비파괴 HTTP 스모크 하니스(docs/pipeline-design.md §9).
//
// verification 블록에 쓰는 세 번째이자 마지막 경로다(record-verification·approve-partial에 이어).
// record-verification이 "사람이 무엇을 돌렸는지 받아 적는" 경로라면, 이쪽은 CLI가 직접 요청을 보내고
// 그 결과로 status를 정한다. 그래서 record-verification보다 제약이 많다 — 자동으로 PASSED를 쓸 수 있는
// 경로이므로, 무엇을 할 수 있는지를 좁게 고정해 두지 않으면 게이트가 아니라 우회로가 된다.
//
// 설계 원칙 네 가지. 전부 "실수로 운영 환경을 건드리는 일"을 막기 위한 것이다.
//  1) **운영 프로파일 거부** — 프로파일은 화이트리스트에 있어야 하고, 이름이 운영으로 읽히면
//     화이트리스트에 넣어도 거부한다(사용자가 뒤집을 수 없는 유일한 규칙).
//  2) **비파괴만** — GET/HEAD만 허용하고 요청 본문을 허용하지 않는다. 리다이렉트도 따라가지 않는다
//     (따라가면 검사 대상이 설정에 없는 호스트로 옮겨간다).
//  3) **소유권 있는 프로세스만 종료** — 서버를 직접 띄웠을 때만 그 자식 프로세스를 죽인다. 이미 떠 있던
//     서버는 우리 것이 아니므로 건드리지 않는다. 성공·실패·예외 어느 경로로 끝나도 정리는 실행된다.
//  4) **설정 누락은 해당 항목만 PARTIAL** — 계정이나 recordId가 없다고 전체를 FAILED로 만들면,
//     "설정이 없다"와 "기능이 깨졌다"가 구분되지 않는다. 없는 항목만 건너뛰고 PARTIAL로 남긴다.
//
// 이 하니스는 보안 경계가 아니다. 설정 파일을 쓸 수 있는 사람은 무엇이든 요청하게 만들 수 있다.
// 목적은 협조적이지만 실수할 수 있는 실행자가 운영 환경을 건드리지 않게 하는 것이다.
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveRepoRoot, resolveSpawn, terminateProcessTree, fail, now } = require('./lib');

const CONFIG_RELATIVE = path.join('.duet', 'verify.json');
// 기본 화이트리스트. 설정에서 넓힐 수 있지만, PRODUCTION_PROFILE에 걸리는 이름은 넓혀도 거부된다.
const DEFAULT_ALLOWED_PROFILES = ['dev', 'local', 'test'];
// 이름이 운영으로 읽히는 프로파일. 화이트리스트보다 강하다 — 설정으로 뒤집을 수 없다.
const PRODUCTION_PROFILE = /(^|[-_.])(prod|production|prd|live|release|main|master)([-_.]|$)/i;
const SAFE_METHODS = ['GET', 'HEAD'];
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];
const DEFAULT_CHECK_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_DURATION_MS = 120_000;
const DEFAULT_READY_TIMEOUT_MS = 30_000;

function readConfig(root) {
  const file = path.join(root, CONFIG_RELATIVE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // 샘플 경로는 계산해서 알려준다. 대상 저장소에서는 node_modules 아래에 있으므로,
    // 'templates/verify.example.json'이라고만 쓰면 그 저장소에 없는 경로를 가리키게 된다.
    const sample = path.join(__dirname, '..', '..', 'templates', 'verify.example.json');
    // 디렉터리째로 없는 경우가 흔하다(`duet-init`은 .gitignore 항목만 추가하고 .duet/를 만들지는 않았다).
    // 그래서 "복사하세요"만 말하지 않고 mkdir까지 함께 보여준다.
    fail([
      `검증 설정이 없습니다: ${file}`,
      '다음 두 단계로 만드세요(이 파일은 커밋하지 않습니다):',
      `  1) mkdir: ${path.dirname(file)}`,
      `  2) copy : ${sample}`
    ].join('\n'));
  }
  let config;
  try { config = JSON.parse(raw); } catch (error) { fail(`검증 설정 JSON을 해석할 수 없습니다(${file}): ${error.message}`); }
  if (!config || typeof config !== 'object' || Array.isArray(config)) fail(`검증 설정은 JSON 객체여야 합니다: ${file}`);
  return { config, file };
}

// 프로파일 게이트. 두 겹인 이유: 화이트리스트는 프로젝트마다 다르지만, "운영을 건드리지 않는다"는
// 프로젝트 사정과 무관하게 지켜져야 한다. 그래서 이름 검사는 설정으로 완화할 수 없게 둔다.
function assertSafeProfile(config) {
  const profile = config.profile;
  if (typeof profile !== 'string' || !profile.trim()) fail('검증 설정에 profile 문자열이 필요합니다.');
  if (PRODUCTION_PROFILE.test(profile)) {
    fail(`운영으로 읽히는 프로파일에는 verify를 실행할 수 없습니다: ${profile}\n이 검사는 allowedProfiles로 완화할 수 없습니다 — 운영 환경 검증은 사람 게이트입니다.`);
  }
  const allowed = config.allowedProfiles ?? DEFAULT_ALLOWED_PROFILES;
  if (!Array.isArray(allowed) || !allowed.every((value) => typeof value === 'string')) fail('allowedProfiles는 문자열 배열이어야 합니다.');
  if (!allowed.includes(profile)) fail(`허용되지 않은 프로파일입니다: ${profile} (허용: ${allowed.join(', ') || '없음'})`);
  return profile;
}

function assertSafeBaseUrl(config) {
  let base;
  try { base = new URL(config.baseUrl); } catch { fail(`baseUrl이 유효한 URL이 아닙니다: ${config.baseUrl}`); }
  if (!['http:', 'https:'].includes(base.protocol)) fail(`baseUrl은 http/https여야 합니다: ${config.baseUrl}`);
  // 기본은 루프백만이다. 원격 호스트를 스모크하려면 설정에서 명시적으로 켜야 한다 — 기본값이 원격이면
  // baseUrl 한 줄 오타로 남의 서버에 요청이 나간다.
  if (!config.allowRemoteHost && !LOOPBACK_HOSTS.includes(base.hostname)) {
    fail(`baseUrl이 루프백 호스트가 아닙니다: ${base.hostname}\n의도한 것이라면 검증 설정에 "allowRemoteHost": true를 넣으세요.`);
  }
  return base;
}

// 설정 경로("records.readOnlyRecordId")나 환경변수("env:VERIFY_PASSWORD")를 값으로 바꾼다.
// 값이 없으면 null — 호출자가 그것을 "건너뜀"으로 해석한다.
function lookup(config, reference) {
  if (reference.startsWith('env:')) {
    const value = process.env[reference.slice(4)];
    return value == null || value === '' ? null : value;
  }
  let cursor = config;
  for (const part of reference.split('.')) {
    if (cursor == null || typeof cursor !== 'object') return null;
    cursor = cursor[part];
  }
  if (cursor == null || cursor === '') return null;
  // 템플릿 자리표시자가 그대로 남은 값은 "설정하지 않은 것"으로 본다. verify.example.json이 이 값을 쓴다.
  if (typeof cursor === 'string' && cursor.trim() === 'replace-locally') return null;
  return String(cursor);
}

// 검사 하나를 실행 가능한 형태로 바꾼다. 실행할 수 없으면 skip 사유를 담아 돌려준다(실패가 아니다).
function planCheck(config, base, check, index) {
  const label = typeof check?.name === 'string' && check.name.trim() ? check.name.trim() : `check#${index + 1}`;
  const method = (check?.method ?? 'GET').toUpperCase();
  // 비파괴 원칙은 설정으로 완화할 수 없다. 하니스가 쓰기를 보낼 수 있으면 "비파괴"라는 말이 의미를 잃는다.
  if (!SAFE_METHODS.includes(method)) fail(`${label}: 비파괴 검증은 ${SAFE_METHODS.join('/')}만 허용합니다(요청: ${method}).`);
  if (check?.body != null) fail(`${label}: 검증 요청에는 본문을 넣을 수 없습니다.`);
  if (typeof check?.path !== 'string' || !check.path.startsWith('/')) fail(`${label}: path는 '/'로 시작하는 문자열이어야 합니다.`);
  const expect = check.expectStatus ?? 200;
  const expected = Array.isArray(expect) ? expect : [expect];
  if (!expected.length || !expected.every((code) => Number.isInteger(code) && code >= 100 && code <= 599)) {
    fail(`${label}: expectStatus는 HTTP 상태 코드(또는 그 배열)여야 합니다.`);
  }

  const missing = [];
  // path 안의 {참조}를 채운다. 하나라도 없으면 이 검사만 건너뛴다.
  const filled = check.path.replace(/\{([^{}]+)\}/g, (_, reference) => {
    const value = lookup(config, reference);
    if (value == null) { missing.push(reference); return ''; }
    return encodeURIComponent(value);
  });
  for (const reference of check.requires ?? []) if (lookup(config, reference) == null) missing.push(reference);

  const headers = { accept: '*/*' };
  // 계정은 설정 파일이 아니라 환경변수에서 온다. 설정 파일에는 "어느 환경변수를 볼지"만 적는다 —
  // .duet/verify.json은 gitignore 대상이지만, 비밀값을 파일에 적게 만드는 순간 언젠가 커밋된다.
  if (check.auth) {
    const usernameEnv = config.credentials?.usernameEnv;
    const passwordEnv = config.credentials?.passwordEnv;
    if (!usernameEnv || !passwordEnv) missing.push('credentials.usernameEnv/passwordEnv');
    else {
      const user = lookup(config, `env:${usernameEnv}`);
      const pass = lookup(config, `env:${passwordEnv}`);
      if (user == null || pass == null) missing.push(`env:${usernameEnv}, env:${passwordEnv}`);
      else headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    }
  }

  if (missing.length) return { name: label, outcome: 'SKIPPED', reason: `설정 누락: ${[...new Set(missing)].join(', ')}` };

  const url = new URL(base.pathname.replace(/\/$/, '') + filled, base);
  // path가 '//host'처럼 시작하면 origin이 바뀐다. 설정에 없는 호스트로 요청이 나가는 것을 막는다.
  if (url.origin !== base.origin) fail(`${label}: path가 baseUrl 밖을 가리킵니다(${url.origin}).`);
  return { name: label, outcome: 'PENDING', method, url, headers, expected, timeoutMs: check.timeoutMs ?? config.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS };
}

// 요청 하나. 리다이렉트를 따라가지 않고, 응답 본문은 버린다(내용 검증은 이 하니스의 범위가 아니다).
function request({ method, url, headers, timeoutMs }) {
  const client = url.protocol === 'https:' ? https : http;
  return new Promise((resolve) => {
    const req = client.request(url, { method, headers, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on('end', () => resolve({ statusCode: res.statusCode }));
    });
    req.on('timeout', () => { req.destroy(new Error(`응답이 ${timeoutMs}ms 안에 오지 않았습니다`)); });
    req.on('error', (error) => resolve({ error: error.message }));
    req.end();
  });
}

async function runChecks(planned, deadline) {
  const results = [];
  for (const check of planned) {
    if (check.outcome === 'SKIPPED') { results.push(check); continue; }
    // 최대 실행 시간을 넘기면 남은 검사는 건너뛴 것이 아니라 **실패**다. timeout을 성공이나 미실행으로
    // 해석하면 "느려서 못 끝낸 것"이 조용히 PASSED가 된다(핸드오프의 timeout 처리와 같은 규율).
    const remaining = deadline - Date.now();
    if (remaining <= 0) { results.push({ name: check.name, outcome: 'FAILED', reason: '최대 실행 시간 초과 전에 실행되지 못했습니다' }); continue; }
    const response = await request({ ...check, timeoutMs: Math.min(check.timeoutMs, remaining) });
    if (response.error) results.push({ name: check.name, outcome: 'FAILED', reason: `요청 실패: ${response.error}` });
    else if (!check.expected.includes(response.statusCode)) {
      results.push({ name: check.name, outcome: 'FAILED', reason: `상태 ${response.statusCode} (기대: ${check.expected.join('|')})` });
    } else results.push({ name: check.name, outcome: 'PASSED', reason: `상태 ${response.statusCode}` });
  }
  return results;
}

// 검사 결과 → verification status. 실패가 하나라도 있으면 FAILED, 실패가 없고 건너뛴 것이 있으면 PARTIAL.
// 실행된 검사가 0건이면 PASSED가 아니라 PARTIAL이다 — "아무것도 안 했다"는 "다 통과했다"가 아니다.
function summarize(results) {
  const failedCount = results.filter((r) => r.outcome === 'FAILED').length;
  if (failedCount) return { status: 'FAILED', failedCount };
  const ran = results.filter((r) => r.outcome === 'PASSED').length;
  if (!ran || results.some((r) => r.outcome === 'SKIPPED')) return { status: 'PARTIAL', failedCount: 0 };
  return { status: 'PASSED', failedCount: 0 };
}

// 서버를 직접 띄운다. **우리가 띄운 것만** 나중에 죽인다 — 이미 떠 있던 서버는 우리 소유가 아니다.
async function startServer(spec, base, deadline) {
  // resolveSpawn이 Windows의 .cmd/.bat(예: 'npm')을 실행 가능한 형태로 바꾼다. 예전에는 shell: false로
  // 그대로 넘겨 `{"command": "npm", "args": ["run", "dev"]}`가 ENOENT/EINVAL로 죽었다 — 문서가 권하는
  // 사용법이 정작 Windows에서 안 되는 상태였다(CI 매트릭스에 있는 플랫폼이다).
  const invocation = resolveSpawn(spec.command, spec.args ?? []);
  // POSIX에서는 detached로 띄워 자식을 프로세스 그룹 리더로 만든다. 그래야 종료할 때 그룹째로 죽여
  // 손자(예: npm → node)까지 정리할 수 있다 — 안 하면 직계 자식만 죽고 실제로 듣고 있는 손자가 남는다.
  // Windows는 taskkill /T가 트리를 처리하므로 detached가 필요 없다.
  const detached = process.platform !== 'win32';
  const child = spawn(invocation.executable, invocation.args, { stdio: 'ignore', shell: false, windowsHide: true, detached, ...invocation.options });
  const owned = { child, pid: child.pid, command: spec.command, group: detached };
  let exited = null;
  child.on('exit', (code, signal) => { exited = { code, signal }; });
  owned.hasExited = () => exited != null;
  const readyPath = spec.readyPath ?? '/';
  const readyUrl = new URL(base.pathname.replace(/\/$/, '') + readyPath, base);
  const readyBy = Math.min(Date.now() + (spec.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS), deadline);
  while (Date.now() < readyBy) {
    if (exited) fail(`검증 서버가 준비되기 전에 종료되었습니다(code=${exited.code}, signal=${exited.signal}).`);
    const response = await request({ method: 'GET', url: readyUrl, headers: { accept: '*/*' }, timeoutMs: 1000 });
    if (!response.error) return owned;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  fail(`검증 서버가 제한 시간 안에 응답하지 않았습니다: ${readyUrl}`);
}

// 소유권 확인 후 종료하고, **끝났는지 확인한 사실만** 돌려준다.
//
// 예전에는 SIGTERM 하나를 보내고 리포트에 `stopped: true`를 무조건 적었다. 두 가지가 틀렸다.
// (1) Windows에는 프로세스 그룹 신호가 없어 부모만 죽고 실제로 듣고 있는 손자가 남는다
//     (`npm run dev` → node). terminateProcessTree를 쓰면 dispatch가 codex에 쓰는 것과 같은 처리가 된다.
// (2) 리포트는 sha256으로 해시돼 verification.evidence에 증거로 남는다. 확인하지 않은 것을 단정하면
//     증거가 거짓을 말한다. 그래서 종료를 기다려 보고, 확인되지 않으면 exited: false로 적는다.
// 이미 죽었거나 권한이 없으면 조용히 넘어간다 — cleanup이 새 예외를 만들어 원래 실패 원인을 덮으면 안 된다.
async function stopServer(owned, graceMs = 3000) {
  if (!owned || !owned.child) return null;
  const alreadyGone = owned.child.exitCode != null || owned.child.signalCode != null || owned.hasExited?.();
  if (alreadyGone) return { pid: owned.pid, exited: true, terminated: false, taskkillExitCode: null, groupKilled: false };
  let termination = { attempted: false, taskkillExitCode: null };
  try { termination = terminateProcessTree(owned.child, { group: owned.group === true }); } catch { /* 트리가 이미 사라졌을 수 있다 */ }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    if (owned.child.exitCode != null || owned.child.signalCode != null || owned.hasExited?.()) {
      return { pid: owned.pid, exited: true, terminated: termination.attempted, taskkillExitCode: termination.taskkillExitCode, groupKilled: termination.groupKilled === true };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  // 여기까지 오면 종료를 확인하지 못했다. 조용히 성공으로 적지 않는다.
  return { pid: owned.pid, exited: false, terminated: termination.attempted, taskkillExitCode: termination.taskkillExitCode, groupKilled: termination.groupKilled === true };
}

async function runVerify({ root = resolveRepoRoot().root, config: injected } = {}) {
  const { config, file } = injected ? { config: injected, file: '(injected)' } : readConfig(root);
  const profile = assertSafeProfile(config);
  const base = assertSafeBaseUrl(config);
  if (!Array.isArray(config.checks) || !config.checks.length) fail('검증 설정에 checks 배열이 필요합니다(비파괴 GET 검사 목록).');

  const maxDurationMs = config.maxDurationMs ?? DEFAULT_MAX_DURATION_MS;
  if (!Number.isInteger(maxDurationMs) || maxDurationMs <= 0) fail('maxDurationMs는 양의 정수여야 합니다.');
  const startedAt = Date.now();
  const deadline = startedAt + maxDurationMs;

  // 계획은 요청 이전에 전부 세운다. 잘못된 설정(파괴적 메서드 등)은 한 건도 보내기 전에 걸려야 한다.
  const planned = config.checks.map((check, index) => planCheck(config, base, check, index));

  let owned = null;
  let results;
  let stopped = null;
  try {
    if (config.server) {
      if (typeof config.server.command !== 'string' || !config.server.command.trim()) fail('server.command는 문자열이어야 합니다.');
      owned = await startServer(config.server, base, deadline);
    }
    results = await runChecks(planned, deadline);
  } finally {
    // 성공·실패·예외 어느 경로로 끝나도 우리가 띄운 프로세스는 정리한다.
    // await한다 — 예전에는 동기 호출이라 종료를 확인하지 못한 채 리포트를 만들었다.
    stopped = await stopServer(owned);
  }

  const summary = summarize(results);
  return {
    ...summary,
    profile,
    baseUrl: base.origin,
    configFile: file,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    // 무엇을 확인했는지 그대로 적는다: exited는 실제 종료를 확인했을 때만 true다.
    spawnedServer: owned ? { command: owned.command, ...stopped } : null,
    results,
    at: now()
  };
}

module.exports = {
  CONFIG_RELATIVE,
  DEFAULT_ALLOWED_PROFILES,
  PRODUCTION_PROFILE,
  SAFE_METHODS,
  readConfig,
  assertSafeProfile,
  assertSafeBaseUrl,
  lookup,
  planCheck,
  runChecks,
  summarize,
  startServer,
  stopServer,
  runVerify
};
