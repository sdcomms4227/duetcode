const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSTALL = path.resolve(__dirname, '..', 'install.js');
const { INSTALLED_DOCS, LEGACY_DOCS } = require(INSTALL);
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

test('배포본 원본이 없으면 대상을 전혀 건드리지 않고 실패한다', () => {
	// v0.1.0에서 package.json의 files에 docs가 빠져 문서 2개가 배포본에 없었다. 그때 존재 검사가
	// 마지막 단계에 있어서 package.json·TASK.md·CI·.gitignore가 이미 쓰인 뒤에 실패했다.
	// 결함 있는 배포본을 실제로 만들어(문서 하나를 뺀 패키지 사본) preflight가 쓰기 이전에 막는지 본다.
	const pkgRoot = path.join(os.tmpdir(), `duet-pkg-${process.pid}-${counter++}`);
	const target = mkTarget();
	try {
		for (const dir of ['scripts', 'templates', 'docs']) {
			fs.cpSync(path.resolve(__dirname, '..', '..', dir), path.join(pkgRoot, dir), { recursive: true });
		}
		fs.rmSync(path.join(pkgRoot, 'docs', 'pipeline-design.md'));
		const before = fs.readdirSync(target).sort();
		const result = spawnSync(process.execPath, [path.join(pkgRoot, 'scripts', 'install.js'), '--target', target], { encoding: 'utf8' });

		assert.notEqual(result.status, 0, 'exit code는 0이 아니어야 한다');
		assert.match(result.stderr, /docs\/pipeline-design\.md/, '어떤 원본이 없는지 알린다');
		assert.match(result.stderr, /files/, 'package.json files 확인을 안내한다');
		assert.deepEqual(fs.readdirSync(target).sort(), before, '실패 시 대상 디렉터리 내용이 변하지 않아야 한다');
		assert.ok(!fs.existsSync(path.join(target, 'package.json')), 'package.json 미생성');
	} finally {
		cleanup(pkgRoot);
		cleanup(target);
	}
});

test('추가할 것이 없는 재실행은 package.json을 건드리지 않는다', () => {
	// 무조건 JSON.stringify로 다시 쓰면 대상이 다른 들여쓰기를 쓸 때 재실행만으로 전체가 재포맷된다.
	// 설치기는 "추가만" 하는 도구이므로 추가할 것이 없으면 파일이 그대로여야 한다.
	const target = mkTarget();
	try {
		assert.equal(run(target).status, 0);
		const pkgPath = path.join(target, 'package.json');
		// 대상이 4-space를 쓰는 상황을 만든다(내용은 그대로, 형식만 다르게).
		const reformatted = JSON.stringify(JSON.parse(fs.readFileSync(pkgPath, 'utf8')), null, 4) + '\n';
		fs.writeFileSync(pkgPath, reformatted);

		const result = run(target);
		assert.equal(result.status, 0);
		assert.equal(fs.readFileSync(pkgPath, 'utf8'), reformatted, '사용자 들여쓰기를 조용히 갈아엎지 않는다');
		assert.match(result.stdout, /skip\(변경 없음\)/, '건드리지 않았다는 사실을 알린다');
	} finally {
		cleanup(target);
	}
});

test('설치가 임시 파일을 남기지 않는다', () => {
	// 대상 파일은 temp→rename으로 쓴다. 중간 산출물이 남으면 대상 저장소가 오염된다.
	const target = mkTarget();
	try {
		assert.equal(run(target).status, 0);
		// readdirSync의 recursive 옵션은 Node 18에서 지원이 갈리므로 직접 순회한다(CI 매트릭스가 18을 돈다).
		const strays = [];
		const walk = (dir) => {
			for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) walk(full);
				else if (entry.name.endsWith('.tmp')) strays.push(path.relative(target, full));
			}
		};
		walk(target);
		assert.deepEqual(strays, [], '임시 파일이 남으면 안 된다');
	} finally {
		cleanup(target);
	}
});

test('.duet/ 디렉터리를 만들고 재실행에 멱등이다', () => {
	// gitignore 대상이라 git에는 아무것도 나타나지 않지만, 없으면 task verify 설정을 두려는 사용자가
	// mkdir부터 해야 한다(실설치 스모크에서 실제로 걸렸다). 핸드오프는 .duet/state/를 스스로 만들고
	// verify는 읽기만 하므로, 만들어 주는 쪽이 일관적이다.
	const target = mkTarget();
	try {
		const first = run(target);
		assert.equal(first.status, 0);
		assert.ok(fs.statSync(path.join(target, '.duet')).isDirectory(), '.duet/ 생성');
		assert.match(first.stdout, /\.duet\//);

		// 사용자가 넣어 둔 것을 재실행이 지우지 않는다.
		fs.writeFileSync(path.join(target, '.duet', 'verify.json'), '{"profile":"dev"}');
		assert.equal(run(target).status, 0);
		assert.equal(fs.readFileSync(path.join(target, '.duet', 'verify.json'), 'utf8'), '{"profile":"dev"}');

		// .gitignore가 .duet/를 무시하므로 git에는 드러나지 않아야 한다.
		assert.match(fs.readFileSync(path.join(target, '.gitignore'), 'utf8'), /^\.duet\/$/m);
	} finally {
		cleanup(target);
	}
});

test('설치되는 docs/ 파일명이 고정되어 있다', () => {
	// 대상 파일명은 공개 계약이다. 설치기는 사용자 파일을 지우지 않으므로, 이름을 바꾸면 기존 설치
	// 대상에 구 파일이 남은 채 신 파일이 추가되어 둘이 공존한다(cc-symphony → duetcode 개명 때 실제로
	// 발생했고, 당시에는 이 단정이 없어 눈으로 확인해야 했다).
	const target = mkTarget();
	try {
		assert.equal(run(target).status, 0);
		const installed = fs.readdirSync(path.join(target, 'docs')).sort();
		assert.deepEqual(installed, [
			'duetcode-collaboration-protocol.md',
			'duetcode-pipeline-design.md',
			'duetcode-pipeline-workflow-example.md'
		], 'docs/에 설치되는 파일 집합이 정확히 이것이어야 한다');
		assert.deepEqual(INSTALLED_DOCS.map(([, name]) => name).sort(), installed, 'INSTALLED_DOCS와 실제 산출물이 일치해야 한다');
	} finally {
		cleanup(target);
	}
});

test('개명 이전 문서가 남아 있으면 공존을 알리되 지우지 않는다', () => {
	// 개명으로 파일명이 바뀌면 구·신 문서가 대상에 공존한다. 자동 삭제는 설치기의 권한이 아니므로
	// 보고만 한다(OBSOLETE_SCRIPTS·tools/ 잔재와 같은 정책).
	const target = mkTarget();
	try {
		fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
		for (const [old] of LEGACY_DOCS) fs.writeFileSync(path.join(target, 'docs', old), '구버전 문서\n');
		const result = run(target);
		assert.equal(result.status, 0);
		for (const [old, current] of LEGACY_DOCS) {
			assert.ok(result.stdout.includes(`docs/${old}`), `${old} 잔재를 알린다`);
			assert.ok(fs.existsSync(path.join(target, 'docs', old)), `${old}를 말없이 지우지 않는다`);
			assert.ok(fs.existsSync(path.join(target, 'docs', current)), `${current}는 새로 설치된다`);
		}
		assert.equal(fs.readFileSync(path.join(target, 'docs', LEGACY_DOCS[0][0]), 'utf8'), '구버전 문서\n', '구 파일 내용도 그대로다');
	} finally {
		cleanup(target);
	}
});

test('LEGACY_DOCS의 대체 대상은 실제로 설치되는 파일이어야 한다', () => {
	// 개명 시 LEGACY_DOCS만 고치고 INSTALLED_DOCS를 빠뜨리면(또는 그 반대) 사용자에게
	// 존재하지 않는 파일로 옮기라고 안내하게 된다.
	const current = new Set(INSTALLED_DOCS.map(([, name]) => name));
	for (const [old, replacement] of LEGACY_DOCS) {
		assert.ok(current.has(replacement), `${old}의 대체 파일 ${replacement}이 INSTALLED_DOCS에 없다`);
		assert.ok(!current.has(old), `${old}는 더 이상 설치되지 않아야 한다`);
	}
});

test('대상 저장소용 워크플로는 이 저장소 CI와 같은 액션 메이저를 쓴다', () => {
	// 액션 메이저를 올린 회차에 이 저장소의 ci.yml만 고치고 템플릿을 빠뜨려, 대상 저장소는 계속
	// 옛 메이저를 설치받았다(경고를 없애려던 변경이 정작 사용자에게는 닿지 않았다).
	// 설치기는 기존 워크플로를 덮어쓰지 않으므로, 이 드리프트는 신규 설치에서만 조용히 굳는다.
	const majors = (file) => {
		const text = fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');
		const found = {};
		for (const [, action, major] of text.matchAll(/uses:\s+(actions\/[\w-]+)@(v\d+)/g)) found[action] = major;
		return found;
	};
	const ours = majors('.github/workflows/ci.yml');
	for (const [action, major] of Object.entries(majors('templates/task-lint.yml'))) {
		assert.equal(major, ours[action], `${action}: 템플릿(${major})이 이 저장소 CI(${ours[action]})와 다르다`);
	}
});

test('커밋이 없는 저장소에서도 실제 브랜치를 적고 git 오류를 흘리지 않는다', () => {
	// `git init` 직후가 부트스트랩의 정상 경로다. 그런데 커밋이 없으면 rev-parse --abbrev-ref HEAD는
	// 실패하므로, 예전에는 (1) 기본 브랜치가 main이 아닌 저장소에 'main'이 적혀 단일 소스가 사실과
	// 다른 브랜치를 말했고 (2) execFileSync가 자식 stderr를 그대로 흘려 성공한 출력 한가운데에
	// git의 fatal 메시지가 찍혔다.
	const target = mkTarget();
	try {
		const init = spawnSync('git', ['init', '-q', '-b', 'develop', target], { encoding: 'utf8' });
		if (init.status !== 0) return; // git이 없는 환경에서는 검사할 것이 없다
		const result = run(target);
		assert.equal(result.status, 0, result.stderr);
		assert.match(fs.readFileSync(path.join(target, 'TASK.md'), 'utf8'), /^branch: develop$/m);
		assert.doesNotMatch(result.stdout + result.stderr, /fatal:/, 'git 내부 오류가 사용자 출력에 새어 나오면 안 된다');
	} finally {
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
