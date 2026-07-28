#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIVE, TERMINAL, EMPTY_VERIFICATION, now, fail, load, save, get, set, git, validate, transition, verifyArchiveRef, resetBody, syncIssueComment } = require('./lib');
const option = (args, name) => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const required = (value, usage) => { if (value == null || value === '') fail(`사용법: ${usage}`); return value; };
// key별로 형변환을 제한한다: issue만 정수, highRisk만 boolean으로 coerce하고, 나머지 식별자 필드
// (id/branch/designCheckpoint/roles.* 등)는 문자열을 보존한다 — 전부 숫자인 짧은 SHA "0012345"가 숫자 12345로
// 뭉개지는 데이터 손실과, --design-checkpoint 경로(문자열)와의 타입 불일치를 방지한다. 'null'은 모든 필드에서 클리어로 인정.
function scalar(key, raw) {
  if (raw === 'null') return null;
  if (key === 'highRisk') { if (raw === 'true') return true; if (raw === 'false') return false; }
  if (key === 'issue' && /^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}
function lint(model) { const errors = validate(model.doc.toJS(), model.body); if (errors.length) fail(errors.join('\n')); }
function requireCleanShare(model) {
  const file = path.relative(process.cwd(), path.resolve(model.file)).replaceAll('\\', '/');
  let status; try { status = git(['status', '--porcelain', '--', file]); } catch { fail('TASK 파일의 Git 상태를 확인할 수 없습니다.'); }
  if (status) fail('현재 종결 상태의 TASK.md를 먼저 커밋해야 reset할 수 있습니다.');
}
function main(args = process.argv.slice(2)) {
  const command = args.shift();
  // 버전 조회는 TASK.md 없이도 동작해야 한다(설치 검증·버전 확인 용도). load()보다 먼저 처리한다.
  // 단일 소스는 package.json — plugin.json과의 일치는 scripts/test/package-meta.test.js가 강제한다.
  if (command === '--version' || command === '-v') return console.log(require('../../package.json').version);
  const model = load(process.env.TASK_STATE_FILE || 'TASK.md');
  if (command === 'show') return console.log(JSON.stringify(model.doc.toJS(), null, 2));
  if (command === 'lint') { lint(model); return console.log('TASK.md lint 통과'); }
  if (command === 'start') {
    if (get(model, 'status') !== 'IDLE') fail('start는 IDLE에서만 허용됩니다.');
    const id = required(args[0], 'task start <id> --objective <목표> --requester <요청자> --designer <설계자>');
    set(model, 'id', id); set(model, 'objective', required(option(args, '--objective'), 'task start <id> --objective <목표> --requester <요청자> --designer <설계자>'));
    set(model, 'requester', required(option(args, '--requester'), 'task start <id> --objective <목표> --requester <요청자> --designer <설계자>'));
    set(model, 'roles', { designer: required(option(args, '--designer'), 'task start <id> --objective <목표> --requester <요청자> --designer <설계자>'), implementer: null, reviewer: null });
    set(model, 'status', 'DESIGN'); set(model, 'verification', null); set(model, 'blocked', null); set(model, 'closure', null);
    resetBody(model); // 이전 Task 본문(stale) 잔존 차단 — front matter만 초기화하던 결함 교정

  } else if (command === 'set') {
    const pairs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--design-checkpoint');
    required(pairs[0], 'task set <key>=<value> [<key>=<value> ...]');
    for (const arg of pairs) {
      const i = arg.indexOf('='); if (i < 1) fail('key=value 형식이 필요합니다.');
      const key = arg.slice(0, i), value = scalar(key, arg.slice(i + 1));
      if (/^(verification|blocked|closure)(\.|$)/.test(key)) fail(`${key}는 전용 명령으로만 수정할 수 있습니다.`);
      if (key === 'status') transition(model, value, option(args, '--design-checkpoint')); else set(model, key, value);
    }
  } else if (command === 'block') {
    const status = get(model, 'status'); if (!ACTIVE.includes(status)) fail('block은 활성 상태에서만 허용됩니다.');
    set(model, 'blocked', { previousStatus: status, reason: required(args.join(' '), 'task block <사유>'), since: now() }); set(model, 'status', 'BLOCKED');
  } else if (command === 'unblock') {
    if (get(model, 'status') !== 'BLOCKED') fail('unblock은 BLOCKED에서만 허용됩니다.'); const previous = get(model, 'blocked.previousStatus'); set(model, 'blocked', null); set(model, 'status', previous);
  } else if (command === 'cancel' || command === 'supersede') {
    const status = get(model, 'status'); if (![...ACTIVE, 'BLOCKED'].includes(status)) fail(`${command}은 활성/BLOCKED 상태에서만 허용됩니다.`);
    const replacementId = command === 'supersede' ? required(args.shift(), 'task supersede <대체ID> <사유>') : null;
    let reason = required(args.join(' '), `task ${command} <사유>`); if (status === 'BLOCKED') reason = `${get(model, 'blocked.reason')} / ${reason}`;
    const target = command === 'cancel' ? 'CANCELLED' : 'SUPERSEDED'; set(model, 'blocked', null); set(model, 'status', target); set(model, 'closure', { type: target, reason, replacementId, archiveRef: null, at: now() });
  } else if (command === 'reset') {
    const status = get(model, 'status'); if (!TERMINAL.includes(status)) fail('reset은 종결 상태에서만 허용됩니다.');
    if (status === 'DONE' || !get(model, 'closure.archiveRef')) requireCleanShare(model);
    for (const key of ['id', 'objective', 'requester', 'roles', 'designCheckpoint', 'issue', 'verification', 'blocked', 'closure']) set(model, key, null);
    set(model, 'highRisk', false); // roles를 null로 지우므로 highRisk도 초기화한다(highRisk→Opus designer 검증이 null designer와 충돌해 reset이 막히는 것 방지)
    set(model, 'status', 'IDLE');
  } else if (command === 'record-verification') {
    if (get(model, 'status') !== 'REVIEW') fail('record-verification은 REVIEW에서만 허용됩니다.');
    const usage = 'task record-verification --status <S> --failed-count <N> [--evidence "<검증 명령>"]';
    const status = required(option(args, '--status'), usage); const count = Number(required(option(args, '--failed-count'), usage));
    if (!['PASSED', 'FAILED', 'PARTIAL'].includes(status) || !Number.isInteger(count) || count < 0) fail('검증 결과 인자가 유효하지 않습니다.');
    // --evidence <명령>: 그 명령을 실제로 실행해 exit code와 출력 해시를 남긴다. 문자열만 받아 적으면
    // "테스트를 돌렸다"는 자기 신고에 지나지 않으므로, 무엇을 근거로 PASSED인지가 기록되지 않는다.
    // 플래그를 줬으면 값도 반드시 있어야 한다. option()은 값이 없으면 undefined를 돌려주므로,
    // 존재 여부를 값으로 판정하면 '--evidence' 오타 하나가 증거 없는 PASSED를 무음으로 통과시킨다.
    const evidenceCommand = args.includes('--evidence') ? required(option(args, '--evidence'), usage) : null;
    let evidence = null;
    if (evidenceCommand != null) {
      if (!evidenceCommand.trim()) fail('--evidence에는 실행할 명령이 필요합니다.');
      const run = require('node:child_process').spawnSync(evidenceCommand, { shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (run.error) fail(`증거 명령을 실행하지 못했습니다: ${run.error.message}`);
      const output = `${run.stdout || ''}${run.stderr || ''}`;
      process.stdout.write(output);
      evidence = {
        command: evidenceCommand,
        exitCode: run.status ?? -1,
        outputSha256: require('node:crypto').createHash('sha256').update(output).digest('hex'),
        at: now()
      };
    }
    set(model, 'verification', { status, failedCount: count, partialApproved: false, approvedBy: null, approvedAt: null, updated: now(), evidence });
  } else if (command === 'approve-partial') {
    if (get(model, 'status') !== 'REVIEW' || get(model, 'verification.status') !== 'PARTIAL') fail('REVIEW의 PARTIAL 결과에서만 승인할 수 있습니다.');
    if (!process.stdin.isTTY || !process.stdout.isTTY) fail('stdin과 stdout이 모두 TTY인 대화형 실행에서만 허용됩니다.');
    process.stdout.write('PARTIAL 검증을 승인하려면 APPROVE를 입력하세요: ');
    const answer = Buffer.alloc(64); const length = fs.readSync(0, answer, 0, answer.length, null);
    if (answer.toString('utf8', 0, length).trim() !== 'APPROVE') fail('승인이 취소되었습니다.');
    set(model, 'verification.partialApproved', true); set(model, 'verification.approvedBy', process.env.USERNAME || process.env.USER || 'interactive-user'); set(model, 'verification.approvedAt', now());
  } else if (command === 'archive') {
    const ref = required(args[0], 'task archive <ref>'); verifyArchiveRef(model, ref); set(model, 'closure.archiveRef', ref);
  } else if (command === 'issue-sync') {
    const issue = get(model, 'issue'); if (!Number.isInteger(issue)) fail('front matter issue 번호가 필요합니다.');
    // 외부 쓰기 전에 검증한다. 공통 lint는 아래(102행)라 gh 호출보다 늦고, 그때는 이미 게시된 뒤다.
    lint(model);
    const data = model.doc.toJS();
    const result = syncIssueComment(data, issue, args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'inherit'] }));
    console.log(`issue #${issue} 동기화 코멘트를 ${result.action === 'updated' ? '갱신했습니다' : '등록했습니다'}.`);
    if (['CANCELLED', 'SUPERSEDED'].includes(data.status)) set(model, 'closure.archiveRef', `issue:#${issue}`);
  } else fail('명령: show|start|set|block|unblock|cancel|supersede|reset|record-verification|archive|approve-partial|lint|issue-sync|--version');
  lint(model);
  save(model);
}
try { main(); } catch (error) { console.error(`task: ${error.message}`); process.exitCode = 1; }
