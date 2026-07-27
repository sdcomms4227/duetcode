const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.resolve(__dirname, '..', 'install.js');
const { renderCiTemplate } = require(INSTALL);
let counter = 0;

function mkTarget() {
	const dir = path.join(os.tmpdir(), `cc-install-test-${process.pid}-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
function run(target, args = []) {
	return spawnSync(process.execPath, [INSTALL, '--target', target, ...args], { encoding: 'utf8' });
}
function cleanup(dir) {
	fs.rmSync(dir, { recursive: true, force: true });
}

test('legacy SHARE.md + TASK.md 부재 → 실패하고 대상 저장소를 전혀 건드리지 않는다', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'SHARE.md'), 'legacy\n');
	const before = fs.readdirSync(target).sort();
	const result = run(target);
	assert.notEqual(result.status, 0, 'exit code는 0이 아니어야 한다');
	assert.match(result.stderr, /legacy SHARE\.md/);
	assert.deepEqual(fs.readdirSync(target).sort(), before, '실패 시 대상 디렉토리 내용이 변하지 않아야 한다');
	assert.ok(!fs.existsSync(path.join(target, 'package.json')), 'package.json 미생성');
	assert.ok(!fs.existsSync(path.join(target, 'tools')), 'tools/ 미생성');
	cleanup(target);
});

test('SHARE.md + TASK.md 공존 → 정상 설치(무중단)', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'SHARE.md'), 'legacy\n');
	fs.writeFileSync(path.join(target, 'TASK.md'), '---\nid: null\nstatus: IDLE\n---\n');
	const result = run(target, ['--no-handoff']);
	assert.equal(result.status, 0, 'exit 0으로 정상 설치');
	assert.ok(fs.existsSync(path.join(target, 'tools', 'task', 'index.js')));
	cleanup(target);
});

test('engine-only는 SHARE.md가 있어도 검사하지 않는다(TASK.md 미생성)', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'SHARE.md'), 'legacy\n');
	const result = run(target, ['--engine-only', '--force']);
	assert.equal(result.status, 0, 'engine-only는 SHARE 검사를 건너뛰고 통과');
	assert.ok(fs.existsSync(path.join(target, 'tools', 'task', 'index.js')));
	assert.ok(!fs.existsSync(path.join(target, 'TASK.md')), 'engine-only는 TASK.md를 만들지 않는다');
	cleanup(target);
});

test('기본 설치 CI는 handoff:test를 포함한다', () => {
	const target = mkTarget();
	const result = run(target);
	assert.equal(result.status, 0);
	const ci = fs.readFileSync(path.join(target, '.github', 'workflows', 'task-lint.yml'), 'utf8');
	assert.match(ci, /npm run task:test/);
	assert.match(ci, /npm run handoff:test/, '기본 설치는 handoff:test 포함');
	assert.ok(!ci.includes('__HANDOFF_TEST__'), '플레이스홀더가 남으면 안 된다');
	cleanup(target);
});

test('--no-handoff 설치 CI는 handoff:test를 제외한다', () => {
	const target = mkTarget();
	const result = run(target, ['--no-handoff']);
	assert.equal(result.status, 0);
	const ci = fs.readFileSync(path.join(target, '.github', 'workflows', 'task-lint.yml'), 'utf8');
	assert.match(ci, /npm run task:test/);
	assert.ok(!/handoff:test/.test(ci), '--no-handoff는 handoff:test 제외');
	assert.ok(!ci.includes('__HANDOFF_TEST__'), '플레이스홀더가 남으면 안 된다');
	cleanup(target);
});

test('renderCiTemplate은 LF·CRLF 템플릿 모두에서 자리표시자를 남기지 않는다', () => {
	// core.autocrlf=true인 Windows clone은 템플릿을 CRLF로 스머지한다. 두 개행 모두에서 치환이 성립해야 한다.
	for (const nl of ['\n', '\r\n']) {
		const label = JSON.stringify(nl);
		const tmpl = `      - run: npm run task:test${nl}__HANDOFF_TEST__${nl}`;
		const withHandoff = renderCiTemplate(tmpl, true);
		assert.ok(!withHandoff.includes('__HANDOFF_TEST__'), `handoff, eol=${label}`);
		assert.match(withHandoff, /npm run handoff:test/);
		const noHandoff = renderCiTemplate(tmpl, false);
		assert.ok(!noHandoff.includes('__HANDOFF_TEST__'), `no-handoff, eol=${label}`);
		assert.ok(!/handoff:test/.test(noHandoff), `no-handoff는 handoff:test 제외, eol=${label}`);
	}
});

test('shipped CI 템플릿은 LF이며 __HANDOFF_TEST__ 자리표시자로 끝난다', () => {
	// .gitattributes(eol=lf)와 함께 이 테스트가 CRLF 회귀(H1)를 이중으로 막는다.
	const tmpl = fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'task-lint.yml'), 'utf8');
	assert.ok(!tmpl.includes('\r'), '템플릿에 CR이 없어야 한다(LF 정규화)');
	assert.match(tmpl, /__HANDOFF_TEST__\n$/, '자리표시자가 파일 끝에 개행과 함께 있어야 한다');
});
