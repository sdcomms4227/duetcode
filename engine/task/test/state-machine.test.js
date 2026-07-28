const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { parseSource } = require('../lib');
const { share, fixture, cli } = require('./helpers');

test('verification 직접 쓰기를 거부한다', () => {
  const result = cli(fixture(), ['set', 'verification.status=PASSED']);
  assert.equal(result.status, 1); assert.match(result.stderr, /전용 명령/);
});

test('invalid set은 파일을 저장하지 않는다', () => {
  const file = fixture(); const before = fs.readFileSync(file, 'utf8');
  const result = cli(file, ['set', 'objective=']); assert.equal(result.status, 1); assert.match(result.stderr, /objective/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('set은 다중 키를 모두 적용한다', () => {
  const file = fixture(); const result = cli(file, ['set', 'branch=x', 'issue=613']); assert.equal(result.status, 0, result.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data; assert.equal(data.branch, 'x'); assert.equal(data.issue, 613);
});

test('set은 식별자 필드를 문자열로 보존하고 issue/highRisk만 coerce한다', () => {
  // 전부 숫자인 짧은 SHA "0012345"·"007"이 숫자로 뭉개지면 앞자리 0 소실·타입 불일치(--design-checkpoint 경로는 문자열).
  const file = fixture();
  const r = cli(file, ['set', 'designCheckpoint=0012345', 'branch=007', 'issue=42', 'highRisk=false']);
  assert.equal(r.status, 0, r.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data;
  assert.strictEqual(data.designCheckpoint, '0012345');
  assert.strictEqual(data.branch, '007');
  assert.strictEqual(data.issue, 42);      // issue는 정수로 coerce
  assert.strictEqual(data.highRisk, false); // highRisk는 boolean으로 coerce(문자열 "false"가 아님)
});

test('다중 set 중 금지 키가 있으면 파일을 저장하지 않는다', () => {
  const file = fixture(); const before = fs.readFileSync(file, 'utf8');
  const result = cli(file, ['set', 'branch=x', 'verification.status=PASSED']); assert.equal(result.status, 1); assert.match(result.stderr, /전용 명령/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('set은 status와 일반 키를 함께 적용한다', () => {
  const file = fixture(); const result = cli(file, ['set', 'issue=613', 'status=IMPLEMENTING']); assert.equal(result.status, 0, result.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data; assert.equal(data.issue, 613); assert.equal(data.status, 'IMPLEMENTING');
  assert.deepEqual(data.verification, { status: null, failedCount: 0, partialApproved: false, approvedBy: null, approvedAt: null, updated: null, evidence: null });
});

test('start는 DESIGN 필수 메타를 원자적으로 생성한다', () => {
  const source = share().replace('id: task-test # 보존할 주석', 'id: null').replace('status: REVIEW', 'status: IDLE')
    .replace('objective: CLI 테스트', 'objective: null').replace('requester: tester', 'requester: null')
    .replace(/roles:\n  designer: Claude\n  implementer: Codex\n  reviewer: Claude/, 'roles: null')
    .replace('designCheckpoint: abc123', 'designCheckpoint: null').replace(/verification:\n(?:  .*\n){6}/, 'verification: null\n');
  const file = fixture(source);
  assert.equal(cli(file, ['start', 'new-task']).status, 1);
  const result = cli(file, ['start', 'new-task', '--objective', '목표', '--requester', '사용자', '--designer', 'Claude']); assert.equal(result.status, 0, result.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data; assert.equal(data.status, 'DESIGN'); assert.equal(data.objective, '목표'); assert.equal(data.roles.designer, 'Claude');
});

test('start는 이전 Task 본문(stale)을 스켈레톤으로 교체한다', () => {
  const source = share().replace('id: task-test # 보존할 주석', 'id: null').replace('status: REVIEW', 'status: IDLE')
    .replace('objective: CLI 테스트', 'objective: null').replace('requester: tester', 'requester: null')
    .replace(/roles:\n  designer: Claude\n  implementer: Codex\n  reviewer: Claude/, 'roles: null')
    .replace('designCheckpoint: abc123', 'designCheckpoint: null').replace(/verification:\n(?:  .*\n){6}/, 'verification: null\n');
  const file = fixture(source);
  assert.match(fs.readFileSync(file, 'utf8'), /실제 요구사항/); // 시작 전 이전 본문 존재
  const result = cli(file, ['start', 'fresh-task', '--objective', '목표', '--requester', '사용자', '--designer', 'Claude']);
  assert.equal(result.status, 0, result.stderr);
  const after = fs.readFileSync(file, 'utf8');
  assert.doesNotMatch(after, /실제 요구사항/); // stale 본문 소멸
  assert.match(after, /## Active Task/); // 헤딩은 보존
  assert.match(after, /- 미정/); // 플레이스홀더로 교체
});

test('start 직후 플레이스홀더 본문은 READY lint를 통과하지 못한다', () => {
  const source = share().replace('id: task-test # 보존할 주석', 'id: null').replace('status: REVIEW', 'status: IDLE')
    .replace('objective: CLI 테스트', 'objective: null').replace('requester: tester', 'requester: null')
    .replace(/roles:\n  designer: Claude\n  implementer: Codex\n  reviewer: Claude/, 'roles: null')
    .replace('designCheckpoint: abc123', 'designCheckpoint: null').replace(/verification:\n(?:  .*\n){6}/, 'verification: null\n');
  const file = fixture(source);
  cli(file, ['start', 'fresh-task', '--objective', '목표', '--requester', '사용자', '--designer', 'Claude']);
  cli(file, ['set', 'roles.implementer=Codex', 'roles.reviewer=Claude', 'designCheckpoint=sha1']);
  const ready = cli(file, ['set', 'status=READY']);
  assert.equal(ready.status, 1); // 플레이스홀더 섹션이 비어 있어 거부
  assert.match(ready.stderr, /섹션이 비어 있습니다/);
});

test('highRisk IDLE Task는 Opus designer로 시작할 수 있다', () => {
  const source = share().replace('id: task-test # 보존할 주석', 'id: null').replace('status: REVIEW', 'status: IDLE')
    .replace('objective: CLI 테스트', 'objective: null').replace('requester: tester', 'requester: null')
    .replace(/roles:\n  designer: Claude\n  implementer: Codex\n  reviewer: Claude/, 'roles: null')
    .replace('designCheckpoint: abc123', 'designCheckpoint: null').replace('highRisk: false', 'highRisk: true')
    .replace(/verification:\n(?:  .*\n){6}/, 'verification: null\n');
  const file = fixture(source);
  const result = cli(file, ['start', 'high-risk-task', '--objective', '목표', '--requester', '사용자', '--designer', 'Opus 4.8']);
  assert.equal(result.status, 0, result.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data; assert.equal(data.status, 'DESIGN'); assert.equal(data.roles.reviewer, null);
});

test('lint는 verification 타입과 REVIEW 필수 불릿을 검사한다', () => {
  const badType = fixture(share().replace('failedCount: 0', 'failedCount: nope'));
  assert.equal(cli(badType, ['lint']).status, 1);
  const badAction = fixture(share().replace('- **다음 행동**: 검토', '- **다음 행동**: 없음'));
  assert.equal(cli(badAction, ['lint']).status, 1);
});

test("'영향 범위'가 미정이면 lint/READY를 거부한다(handoff build-prompt와 정렬)", () => {
  // validate가 영향 범위를 검사하지 않던 시절엔 lint 통과 후 handoff가 PROMPT_SECTION_UNDECIDED로 거부했다("lint통과≠위임가능").
  const file = fixture(share().replace('- 실제 영향 범위', '- 미정'));
  const result = cli(file, ['lint']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /영향 범위/);
});

test('REVIEW → IMPLEMENTING은 verification을 원자 초기화한다', () => {
  const file = fixture(); const result = cli(file, ['set', 'status=IMPLEMENTING']); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseSource(fs.readFileSync(file, 'utf8')).data.verification, { status: null, failedCount: 0, partialApproved: false, approvedBy: null, approvedAt: null, updated: null, evidence: null });
  const done = cli(file, ['set', 'status=DONE']); assert.equal(done.status, 1); assert.match(done.stderr, /허용되지 않은 전환/);
});

test('IMPLEMENTING → REVIEW는 verification을 원자 초기화한다', () => {
  const file = fixture(share().replace('status: REVIEW', 'status: IMPLEMENTING').replace(/verification:\n(?:  .*\n){6}/, 'verification: null\n'));
  const result = cli(file, ['set', 'status=REVIEW']); assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(parseSource(fs.readFileSync(file, 'utf8')).data.verification, { status: null, failedCount: 0, partialApproved: false, approvedBy: null, approvedAt: null, updated: null, evidence: null });
});

test('REVIEW의 PASSED 검증은 DONE 전환을 허용한다', () => {
  const file = fixture(); const result = cli(file, ['set', 'status=DONE']); assert.equal(result.status, 0, result.stderr);
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.status, 'DONE');
});

test('REVIEW → READY는 새 checkpoint가 필수다', () => {
  const file = fixture(); assert.equal(cli(file, ['set', 'status=READY']).status, 1);
  assert.equal(cli(file, ['set', 'status=READY', '--design-checkpoint', 'def456']).status, 0);
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.designCheckpoint, 'def456');
});

test('record-verification은 승인 필드를 초기화한다', () => {
  const file = fixture(share().replace('partialApproved: false', 'partialApproved: true').replace('approvedBy: null', 'approvedBy: human').replace('approvedAt: null', 'approvedAt: 2026-07-14T01:00:00Z'));
  const result = cli(file, ['record-verification', '--status', 'PARTIAL', '--failed-count', '0']); assert.equal(result.status, 0, result.stderr);
  const v = parseSource(fs.readFileSync(file, 'utf8')).data.verification; assert.equal(v.partialApproved, false); assert.equal(v.approvedBy, null); assert.equal(v.approvedAt, null);
});

test('비대화형 approve-partial을 거부한다', () => {
  const file = fixture(share().replace('status: PASSED\n  failedCount', 'status: PARTIAL\n  failedCount'));
  const result = cli(file, ['approve-partial'], 'yes\n'); assert.equal(result.status, 1); assert.match(result.stderr, /TTY/);
});

test('archiveRef 없고 미커밋인 CANCELLED Task의 reset을 거부한다', () => {
  // 격리된 임시 git 저장소에 미커밋 TASK.md를 두고 그 안(cwd)에서 실행한다.
  // requireCleanShare가 `git status --porcelain`으로 untracked를 감지해 reset을 막는 경로를,
  // 주변 설치 디렉터리의 git 여부와 무관하게 재현한다(예전엔 설치 트리에 픽스처를 써서 git 백엔드 설치에서만 통과했다).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-reset-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    const file = path.join(dir, 'TASK.md');
    fs.writeFileSync(file, share().replace('status: REVIEW', 'status: CANCELLED').replace('closure: null', 'closure:\n  type: CANCELLED\n  reason: 중단\n  replacementId: null\n  archiveRef: null\n  at: 2026-07-14T00:00:00Z'));
    const result = cli(file, ['reset'], undefined, dir); assert.equal(result.status, 1); assert.match(result.stderr, /먼저 커밋/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('highRisk Task의 reset은 highRisk를 false로 초기화한다', () => {
  // reset이 roles를 null로 지우면서 highRisk를 남기면, highRisk→Opus designer 검증이 null designer와 충돌해 막힌다.
  // archiveRef가 있는 CANCELLED는 git clean 게이트를 건너뛰므로 이 결함을 격리 재현한다.
  const source = share()
    .replace('highRisk: false', 'highRisk: true')
    .replace('status: REVIEW', 'status: CANCELLED')
    .replace('closure: null', 'closure:\n  type: CANCELLED\n  reason: 중단\n  replacementId: null\n  archiveRef: "docs:archive.md"\n  at: 2026-07-14T00:00:00Z');
  const file = fixture(source);
  const result = cli(file, ['reset']);
  assert.equal(result.status, 0, result.stderr);
  const data = parseSource(fs.readFileSync(file, 'utf8')).data;
  assert.equal(data.status, 'IDLE');
  assert.equal(data.highRisk, false);
  assert.equal(data.roles, null);
});

test('--evidence는 명령을 실제로 실행해 exit code와 출력 해시를 남긴다', () => {
  // "테스트를 돌렸다"는 자기 신고와 "무엇을 근거로 PASSED인가"를 구분하기 위한 필드다.
  const file = fixture();
  const result = cli(file, ['record-verification', '--status', 'PASSED', '--failed-count', '0', '--evidence', 'node -e "console.log(42)"']);
  assert.equal(result.status, 0, result.stderr);
  const e = parseSource(fs.readFileSync(file, 'utf8')).data.verification.evidence;
  assert.equal(e.command, 'node -e "console.log(42)"');
  assert.equal(e.exitCode, 0);
  assert.match(e.outputSha256, /^[a-f0-9]{64}$/);
  assert.equal(e.outputSha256, createHash('sha256').update('42\n').digest('hex'), '출력 해시가 실제 출력과 일치한다');
  assert.match(e.at, /^\d{4}-\d{2}-\d{2}T/);
});

test('증거가 실패를 말하는데 PASSED로 기록하면 거부한다', () => {
  const file = fixture();
  const result = cli(file, ['record-verification', '--status', 'PASSED', '--failed-count', '0', '--evidence', 'node -e "process.exit(3)"']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /exitCode가 0이 아닙니다/);
  // 거부됐으므로 파일은 그대로여야 한다(모순된 기록이 남지 않는다).
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.verification.status, 'PASSED');
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.verification.evidence, undefined);
});

test('실패한 증거는 FAILED로는 기록된다', () => {
  const file = fixture();
  const result = cli(file, ['record-verification', '--status', 'FAILED', '--failed-count', '2', '--evidence', 'node -e "process.exit(3)"']);
  assert.equal(result.status, 0, result.stderr);
  const v = parseSource(fs.readFileSync(file, 'utf8')).data.verification;
  assert.equal(v.status, 'FAILED');
  assert.equal(v.evidence.exitCode, 3);
});

test('--evidence 없이도 기존처럼 기록된다(구버전 호환)', () => {
  const file = fixture();
  const result = cli(file, ['record-verification', '--status', 'PASSED', '--failed-count', '0']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.verification.evidence, null);
});

test('값 없는 --evidence는 증거 없이 통과시키지 않고 거부한다', () => {
  // 증거 기록은 "테스트를 돌렸다"는 자기 신고를 막는 장치다. 플래그 오타 하나로 그 장치가
  // 무음으로 꺼지면(증거 없는 PASSED가 기록되면) 장치가 있으나 마나다.
  const file = fixture();
  const before = fs.readFileSync(file, 'utf8');
  const result = cli(file, ['record-verification', '--status', 'PASSED', '--failed-count', '0', '--evidence']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /사용법/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('저장은 임시 파일을 남기지 않는다(원자적 쓰기)', () => {
  // TASK.md는 파이프라인 전체가 걸린 단일 소스라 tmp+rename으로 쓴다. 잔여 tmp가 남으면
  // 그 자체가 실패 신호이고, 대상 저장소의 git status도 더럽힌다.
  const file = fixture();
  assert.equal(cli(file, ['set', 'issue=7']).status, 0);
  const leftovers = fs.readdirSync(path.dirname(file)).filter((name) => name.includes('.tmp'));
  assert.deepEqual(leftovers, [], `임시 파일이 남았다: ${leftovers.join(', ')}`);
  assert.equal(parseSource(fs.readFileSync(file, 'utf8')).data.issue, 7, '내용은 정상 반영된다');
});
