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

test('--no-handoff는 실행 불가능한 handoff 스크립트를 남기지 않는다', () => {
	// 회귀: tools/handoff를 설치하지 않으면서 handoff·handoff:test 스크립트만 추가해,
	// npm run handoff가 MODULE_NOT_FOUND로 죽는 설치본이 나왔다.
	const target = mkTarget();
	const result = run(target, ['--no-handoff']);
	assert.equal(result.status, 0);
	assert.ok(!fs.existsSync(path.join(target, 'tools', 'handoff')), 'tools/handoff는 설치되지 않는다');
	const scripts = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).scripts;
	assert.ok(!('handoff' in scripts), 'handoff 스크립트 없음');
	assert.ok(!('handoff:test' in scripts), 'handoff:test 스크립트 없음');
	assert.ok('task' in scripts && 'task:test' in scripts, 'task 스크립트는 그대로 설치된다');
	cleanup(target);
});

test('설치된 npm 스크립트는 모두 실제 파일을 가리키고 셸 glob에 의존하지 않는다', () => {
	// 회귀: glob·디렉터리 축약형은 셸·Node 버전마다 동작이 갈린다(cmd.exe는 glob을 확장하지 않고
	// Node 자체 glob은 21+라 18·20은 "Could not find"; 디렉터리 인자는 18·20 재귀 / 22 MODULE_NOT_FOUND).
	for (const args of [[], ['--no-handoff']]) {
		const label = args.length ? args[0] : 'default';
		const target = mkTarget();
		assert.equal(run(target, args).status, 0, `${label} 설치 실패`);
		const scripts = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).scripts;
		for (const [name, command] of Object.entries(scripts)) {
			assert.ok(!command.includes('*'), `${label}/${name}: 셸 glob 의존 금지 — ${command}`);
			const match = command.match(/(tools\/[\w./-]+)/);
			assert.ok(match, `${label}/${name}: tools/ 경로를 찾을 수 없다 — ${command}`);
			const entry = path.join(target, match[1]);
			assert.ok(fs.existsSync(entry) && fs.statSync(entry).isFile(),
				`${label}/${name}이 가리키는 ${match[1]}이 실제 파일이 아니다`);
		}
		cleanup(target);
	}
});

test('구형 테스트 스크립트는 갱신하고, 사용자가 바꾼 스크립트는 보존한다', () => {
	// 회귀: mergePackageJson이 "값이 다르면 충돌 보고"만 해서, 기존 설치본에는 폐기된 glob 명령이 영영 남았다.
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
		scripts: {
			'task:test': 'node --test tools/task/test/*.test.js',
			'handoff:test': 'node --test tools/handoff/test/*.test.js',
			task: 'echo 사용자가 직접 바꾼 스크립트'
		}
	}, null, 2) + '\n');
	const result = run(target);
	assert.equal(result.status, 0);
	const scripts = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).scripts;
	assert.equal(scripts['task:test'], 'node tools/task/test/run.js', '알려진 구형 값은 갱신된다');
	assert.equal(scripts['handoff:test'], 'node tools/handoff/test/run.js', '알려진 구형 값은 갱신된다');
	assert.equal(scripts.task, 'echo 사용자가 직접 바꾼 스크립트', '사용자 값은 보존된다');
	assert.match(result.stdout, /scripts\.task \(기존:/, '보존한 값은 충돌로 보고한다');
	cleanup(target);
});

test('.gitignore는 항목 단위로 병합하며 반복 실행에 멱등이다', () => {
	// 회귀: 'tools/handoff/state/' 한 줄만 있으면 전체를 건너뛰어, 스니펫에 항목이 추가돼도
	// 기존 설치 저장소에는 영영 전달되지 않았다.
	const target = mkTarget();
	const gi = path.join(target, '.gitignore');
	fs.writeFileSync(gi, '# 기존 사용자 규칙\ntools/handoff/state/\n');
	assert.equal(run(target).status, 0);
	const merged = fs.readFileSync(gi, 'utf8');
	assert.match(merged, /^# 기존 사용자 규칙$/m, '기존 내용 보존');
	assert.match(merged, /^node_modules\/$/m, '없던 항목은 추가된다');
	assert.equal(merged.match(/^tools\/handoff\/state\/$/gm).length, 1, '이미 있는 항목은 중복되지 않는다');
	assert.equal(run(target).status, 0);
	assert.equal(fs.readFileSync(gi, 'utf8'), merged, '반복 실행은 파일을 바꾸지 않는다');
	cleanup(target);
});

test('.gitignore가 없거나 비어 있어도 스니펫 항목이 모두 들어간다', () => {
	for (const seed of [null, '', '\n']) {
		const label = JSON.stringify(seed);
		const target = mkTarget();
		if (seed !== null) fs.writeFileSync(path.join(target, '.gitignore'), seed);
		assert.equal(run(target).status, 0, `seed=${label} 설치 실패`);
		const lines = fs.readFileSync(path.join(target, '.gitignore'), 'utf8').split(/\r?\n/);
		for (const entry of ['node_modules/', 'tools/handoff/state/', 'tools/task/verify.local.json']) {
			assert.ok(lines.includes(entry), `seed=${label}: ${entry} 누락`);
		}
		cleanup(target);
	}
});

test('--engine-only는 package.json을 수정하지 않고 구형 스크립트를 보고한다', () => {
	const target = mkTarget();
	const raw = JSON.stringify({ scripts: { 'task:test': 'node --test tools/task/test/*.test.js' } }, null, 2) + '\n';
	fs.writeFileSync(path.join(target, 'package.json'), raw);
	const result = run(target, ['--engine-only', '--force']);
	assert.equal(result.status, 0);
	assert.equal(fs.readFileSync(path.join(target, 'package.json'), 'utf8'), raw, 'engine-only는 package.json을 건드리지 않는다');
	assert.match(result.stdout, /구형 스크립트/, '구형 스크립트의 존재를 알린다');
	assert.match(result.stdout, /node tools\/task\/test\/run\.js/, '갱신할 값을 보여준다');
	cleanup(target);
});

test('shipped CI 템플릿은 LF이며 __HANDOFF_TEST__ 자리표시자로 끝난다', () => {
	// .gitattributes(eol=lf)와 함께 이 테스트가 CRLF 회귀(H1)를 이중으로 막는다.
	const tmpl = fs.readFileSync(path.resolve(__dirname, '..', '..', 'templates', 'task-lint.yml'), 'utf8');
	assert.ok(!tmpl.includes('\r'), '템플릿에 CR이 없어야 한다(LF 정규화)');
	assert.match(tmpl, /__HANDOFF_TEST__\n$/, '자리표시자가 파일 끝에 개행과 함께 있어야 한다');
});
