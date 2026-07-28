const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'sync-version.js');
const { TARGETS, readVersion, inspect } = require(SCRIPT);

const run = (args, cwd = ROOT) =>
	spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });

// 이 저장소 자체가 드리프트 없는 상태여야 한다. v0.1.2를 릴리스한 뒤에도 README·설치 스킬·
// 설치 스니펫이 #v0.1.1을 가리킨 채 남아 있었고, 스니펫은 대상 저장소의 devDependency로
// 그대로 써지므로 "안내만 옛날"이 아니라 "설치되는 엔진이 옛날"이었다.
test('저장소의 버전 참조가 package.json과 일치한다', () => {
	const result = run(['--check']);
	assert.equal(result.status, 0, `버전 드리프트가 있다:\n${result.stderr}`);
});

test('--check는 파일을 고치지 않는다', () => {
	const version = readVersion();
	const before = TARGETS.map((t) => fs.readFileSync(path.join(ROOT, t.file), 'utf8'));
	run(['--check']);
	TARGETS.forEach((t, i) => {
		assert.equal(fs.readFileSync(path.join(ROOT, t.file), 'utf8'), before[i],
			`--check가 ${t.file}을 건드렸다`);
	});
	assert.ok(version);
});

test('모든 동기화 대상에서 버전 참조를 실제로 찾는다', () => {
	// 대상 파일의 구조가 바뀌어 패턴이 안 걸리면 동기화는 아무것도 하지 않은 채
	// 계속 "성공"한다. inspect가 그 경우 던지는지 고정한다.
	const version = readVersion();
	for (const target of TARGETS) {
		assert.doesNotThrow(() => inspect(target, version), `${target.file}에서 패턴이 안 걸린다`);
	}
});

test('드리프트가 있으면 --check가 exit 1로 알리고, 동기화가 고친다', (t) => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duet-sync-'));
	t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

	// 실제 저장소를 훼손하지 않도록, 대상 파일만 복제한 최소 트리에서 검증한다.
	const version = readVersion();
	fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version }));
	for (const target of TARGETS) {
		const dest = path.join(dir, target.file);
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		const content = fs.readFileSync(path.join(ROOT, target.file), 'utf8');
		// 버전을 낡은 값으로 되돌려 드리프트를 만든다.
		fs.writeFileSync(dest, content.split(version).join('0.0.1'));
	}
	const copied = path.join(dir, 'scripts');
	fs.mkdirSync(copied, { recursive: true });
	fs.copyFileSync(SCRIPT, path.join(copied, 'sync-version.js'));
	const script = path.join(copied, 'sync-version.js');

	const checked = spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8' });
	assert.equal(checked.status, 1, '드리프트를 감지하지 못했다');
	assert.match(checked.stderr, /0\.0\.1/);

	const fixed = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
	assert.equal(fixed.status, 0, fixed.stderr);
	for (const target of TARGETS) {
		const after = fs.readFileSync(path.join(dir, target.file), 'utf8');
		assert.ok(!after.includes('0.0.1'), `${target.file}에 낡은 버전이 남았다`);
	}

	// 두 번째 실행은 아무것도 바꾸지 않는다(멱등).
	const again = spawnSync(process.execPath, [script, '--check'], { cwd: dir, encoding: 'utf8' });
	assert.equal(again.status, 0, again.stderr);
});

test('version 라이프사이클이 동기화를 부르되 커밋을 자동화하지 않는다', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.ok(pkg.scripts.version, 'package.json에 version 라이프사이클 스크립트가 없다');
	assert.match(pkg.scripts.version, /version:sync|sync-version\.js/);
	assert.match(pkg.scripts['version:sync'] || '', /sync-version\.js/);
	assert.match(pkg.scripts['version:check'] || '', /sync-version\.js\s+--check/);
	assert.doesNotMatch(pkg.scripts.version, /\bgit\b|\bnpm\s+version\b/,
		'version 라이프사이클이 사람의 커밋·태그 게이트를 자동화한다');
});
