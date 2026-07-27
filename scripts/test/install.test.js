const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.resolve(__dirname, '..', 'install.js');
let counter = 0;

function mkTarget() {
	const dir = path.join(os.tmpdir(), `duet-init-test-${process.pid}-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}
function run(target, args = []) {
	return spawnSync(process.execPath, [INSTALL, '--target', target, ...args], { encoding: 'utf8' });
}
function scriptsOf(target) {
	return JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).scripts;
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
	cleanup(target);
});

test('SHARE.md + TASK.md 공존 → 정상 부트스트랩(무중단)', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'SHARE.md'), 'legacy\n');
	fs.writeFileSync(path.join(target, 'TASK.md'), '---\nid: null\nstatus: IDLE\n---\n');
	const result = run(target, ['--no-handoff']);
	assert.equal(result.status, 0, 'exit 0으로 정상 설치');
	assert.ok(fs.existsSync(path.join(target, 'package.json')));
	cleanup(target);
});

test('엔진을 복사하지 않고 devDependency로 참조한다', () => {
	// 외부화의 핵심 계약: 대상 저장소에 tools/ 엔진 사본이 생기지 않는다.
	const target = mkTarget();
	assert.equal(run(target).status, 0);
	assert.ok(!fs.existsSync(path.join(target, 'tools')), 'tools/ 미생성');
	const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
	assert.ok(pkg.devDependencies.duetcode, 'duetcode가 devDependency로 들어간다');
	assert.equal(pkg.devDependencies.yaml, undefined, 'yaml은 엔진의 전이 의존성이므로 대상에 넣지 않는다');
	cleanup(target);
});

test('설치된 스크립트는 duet-* 실행 파일을 부르고 경로·glob에 의존하지 않는다', () => {
	// 회귀: 셸 glob은 셸·Node 버전마다 동작이 갈렸고, tools/ 경로는 엔진 위치를 가정했다.
	for (const args of [[], ['--no-handoff']]) {
		const label = args.length ? args[0] : 'default';
		const target = mkTarget();
		assert.equal(run(target, args).status, 0, `${label} 설치 실패`);
		const scripts = scriptsOf(target);
		for (const [name, command] of Object.entries(scripts)) {
			assert.ok(!command.includes('*'), `${label}/${name}: 셸 glob 의존 금지 — ${command}`);
			assert.ok(!command.includes('tools/'), `${label}/${name}: 엔진 위치 가정 금지 — ${command}`);
			assert.match(command, /^duet-(task|handoff)/, `${label}/${name}: duet-* 실행 파일이어야 한다 — ${command}`);
		}
		cleanup(target);
	}
});

test('--no-handoff는 handoff 스크립트를 넣지 않고, 기존 값도 건드리지 않는다', () => {
	const target = mkTarget();
	assert.equal(run(target, ['--no-handoff']).status, 0);
	assert.equal(scriptsOf(target).handoff, undefined, 'handoff 스크립트 없음');
	assert.ok('task' in scriptsOf(target), 'task 스크립트는 설치된다');

	// 이미 있는 handoff 스크립트는 --no-handoff로 재실행해도 보존된다("추가 안 함"이지 "제거"가 아니다).
	const pkgPath = path.join(target, 'package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	pkg.scripts.handoff = 'duet-handoff';
	fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
	assert.equal(run(target, ['--no-handoff']).status, 0);
	assert.equal(scriptsOf(target).handoff, 'duet-handoff', '기존 값 보존');
	cleanup(target);
});

test('구형 tools/ 스크립트는 duet-*로 마이그레이션하고 사용자 값은 보존한다', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
		scripts: {
			task: 'node tools/task/index.js',
			'task:lint': 'node tools/task/index.js lint',
			handoff: 'node tools/handoff/dispatch.js',
			build: 'echo 사용자가 직접 쓴 스크립트'
		}
	}, null, 2) + '\n');
	const result = run(target);
	assert.equal(result.status, 0);
	const scripts = scriptsOf(target);
	assert.equal(scripts.task, 'duet-task');
	assert.equal(scripts['task:lint'], 'duet-task lint');
	assert.equal(scripts.handoff, 'duet-handoff');
	assert.equal(scripts.build, 'echo 사용자가 직접 쓴 스크립트', '사용자 값은 보존된다');
	cleanup(target);
});

test('사용자가 바꾼 스크립트는 갱신하지 않고 충돌로 보고한다', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
		scripts: { task: 'node scripts/my-own-task.js' }
	}, null, 2) + '\n');
	const result = run(target);
	assert.equal(result.status, 0);
	assert.equal(scriptsOf(target).task, 'node scripts/my-own-task.js', '사용자 값 보존');
	assert.match(result.stdout, /scripts\.task \(기존:/, '충돌로 보고한다');
	cleanup(target);
});

test('구버전 잔재(엔진 테스트 스크립트·tools/ 사본)를 지우지 않고 알린다', () => {
	const target = mkTarget();
	fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({
		scripts: { 'task:test': 'node tools/task/test/run.js', 'handoff:test': 'node tools/handoff/test/run.js' }
	}, null, 2) + '\n');
	fs.mkdirSync(path.join(target, 'tools', 'task'), { recursive: true });
	const result = run(target);
	assert.equal(result.status, 0);
	assert.match(result.stdout, /scripts\.task:test/, '불필요해진 스크립트를 알린다');
	assert.match(result.stdout, /tools\//, '엔진 사본 잔재를 알린다');
	const scripts = scriptsOf(target);
	assert.ok('task:test' in scripts, '사용자 스크립트를 말없이 지우지 않는다');
	assert.ok(fs.existsSync(path.join(target, 'tools', 'task')), 'tools/도 말없이 지우지 않는다');
	cleanup(target);
});

test('CI 워크플로는 task:lint만 검증한다', () => {
	// 엔진 테스트는 상류(duetcode)에서 돈다. 대상 CI가 엔진을 다시 테스트할 이유가 없다.
	const target = mkTarget();
	assert.equal(run(target).status, 0);
	const ci = fs.readFileSync(path.join(target, '.github', 'workflows', 'task-lint.yml'), 'utf8');
	assert.match(ci, /npm run task:lint/);
	assert.ok(!/task:test|handoff:test/.test(ci), '엔진 테스트 스텝 없음');
	assert.ok(!ci.includes('__'), '치환되지 않은 자리표시자가 남으면 안 된다');
	cleanup(target);
});

test('.gitignore는 항목 단위로 병합하며 반복 실행에 멱등이다', () => {
	// 회귀: 한 줄만 있으면 전체를 건너뛰어, 스니펫에 항목이 추가돼도 기존 저장소에는 전달되지 않았다.
	const target = mkTarget();
	const gi = path.join(target, '.gitignore');
	fs.writeFileSync(gi, '# 기존 사용자 규칙\nnode_modules/\n');
	assert.equal(run(target).status, 0);
	const merged = fs.readFileSync(gi, 'utf8');
	assert.match(merged, /^# 기존 사용자 규칙$/m, '기존 내용 보존');
	assert.match(merged, /^\.duet\/$/m, '없던 항목은 추가된다');
	assert.equal(merged.match(/^node_modules\/$/gm).length, 1, '이미 있는 항목은 중복되지 않는다');
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
		for (const entry of ['node_modules/', '.duet/']) {
			assert.ok(lines.includes(entry), `seed=${label}: ${entry} 누락`);
		}
		cleanup(target);
	}
});

test('TASK.md는 IDLE 상태로 생성되고 재실행 시 보존된다', () => {
	const target = mkTarget();
	assert.equal(run(target).status, 0);
	const first = fs.readFileSync(path.join(target, 'TASK.md'), 'utf8');
	assert.match(first, /status: IDLE/);
	assert.ok(!first.includes('__BRANCH__') && !first.includes('__UPDATED__'), '자리표시자가 치환된다');
	assert.equal(run(target).status, 0);
	assert.equal(fs.readFileSync(path.join(target, 'TASK.md'), 'utf8'), first, '기존 TASK.md는 보존된다');
	cleanup(target);
});
