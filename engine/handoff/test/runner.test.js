const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// handoff 러너는 task 러너와 같은 로직이지만 별도 파일로 설치되므로 계약도 따로 고정한다
// (한쪽만 깨지는 것을 막는다). 근거는 engine/task/test/runner.test.js 참조.
const RUNNER = path.join(__dirname, 'run.js');

function sandbox(files) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-runner-'));
	fs.copyFileSync(RUNNER, path.join(dir, 'run.js'));
	for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
	return dir;
}
function runRunner(dir) {
	return spawnSync(process.execPath, [path.join(dir, 'run.js')], { encoding: 'utf8' });
}

test('테스트 파일이 0개면 통과가 아니라 실패로 끝낸다', () => {
	const dir = sandbox({});
	try {
		const result = runRunner(dir);
		assert.notEqual(result.status, 0, '대상이 없으면 exit 0이면 안 된다');
		assert.match(result.stderr, /실행할 테스트 파일이 없습니다/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('실패한 테스트의 exit code를 전파한다', () => {
	const dir = sandbox({ 'fail.test.js': "require('node:test').test('실패', () => { throw new Error('boom'); });\n" });
	try {
		assert.notEqual(runRunner(dir).status, 0, '하위 테스트 실패가 러너 exit code에 반영되어야 한다');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('*.test.js만 실행하고 헬퍼 모듈은 건드리지 않는다', () => {
	const dir = sandbox({
		'ok.test.js': "require('node:test').test('통과', () => {});\n",
		'helpers.js': "throw new Error('헬퍼가 테스트로 실행됐다');\n"
	});
	try {
		const result = runRunner(dir);
		assert.equal(result.status, 0, `헬퍼가 실행됐거나 테스트가 실패했다: ${result.stderr}`);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
