const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { handleInterrupt, interruptState } = require('../dispatch');
const { EXIT_CODES } = require('../lib');

// 살아 있는 자식 하나. 가짜 객체가 아니라 실제 프로세스를 쓴다 — terminateProcessTree가 정말
// 죽이는지가 이 테스트의 요점이고, 가짜는 "kill이 호출됐다"까지만 증명한다.
function sleeper() {
	return spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
}
const exited = (child) => child.exitCode != null || child.signalCode != null;
async function waitGone(child, ms = 3000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline && !exited(child)) await new Promise((r) => setTimeout(r, 50));
	return exited(child);
}
function reset() {
	interruptState.child = null;
	interruptState.lock = null;
	interruptState.group = false;
	interruptState.releaseLock = null;
}

test('중단 신호는 Codex를 죽이고 lock을 해제하고 INCOMPLETE(5)로 끝낸다', async () => {
	// Ctrl-C가 codex를 고아로 남기지 않는다는 것이 detached 전환의 전제다. 그리고 Node의 기본 SIGINT
	// 처리는 finally를 실행하지 않으므로, lock 해제를 핸들러가 직접 해야 한다.
	const child = sleeper();
	const released = [];
	try {
		interruptState.child = child;
		interruptState.group = false; // 이 자식은 detached가 아니므로 그룹 종료를 시도하지 않아야 한다
		interruptState.lock = { file: 'fake.lock', token: 't' };
		interruptState.releaseLock = (lock) => released.push(lock);

		const codes = [];
		handleInterrupt('SIGINT', (code) => codes.push(code));

		assert.deepEqual(codes, [EXIT_CODES.INCOMPLETE], 'abort 경로와 같은 exit code여야 한다');
		assert.equal(released.length, 1, 'lock을 해제해야 한다');
		assert.equal(released[0].token, 't');
		assert.ok(await waitGone(child), 'Codex 프로세스가 실제로 죽어야 한다');
		// 두 번 정리하지 않도록 등록을 비운다(신호가 연달아 올 수 있다).
		assert.equal(interruptState.child, null);
		assert.equal(interruptState.lock, null);
	} finally {
		try { child.kill('SIGKILL'); } catch { /* 이미 죽었다 */ }
		reset();
	}
});

test('lock 해제가 실패해도 핸들러는 던지지 않고 종료한다', () => {
	// 핸들러에서 예외가 나면 정리 자체가 무산된다. lock 파일이 손상된 경우가 실제로 있다(STATE_INVALID).
	const codes = [];
	try {
		interruptState.child = null;
		interruptState.lock = { file: 'broken.lock' };
		interruptState.releaseLock = () => { throw new Error('STATE_INVALID'); };
		handleInterrupt('SIGTERM', (code) => codes.push(code));
		assert.deepEqual(codes, [EXIT_CODES.INCOMPLETE]);
	} finally {
		reset();
	}
});

test('정리할 것이 없으면 조용히 종료한다', () => {
	// lock을 잡기 전이나 codex가 이미 끝난 뒤에도 신호는 올 수 있다.
	const codes = [];
	try {
		reset();
		handleInterrupt('SIGHUP', (code) => codes.push(code));
		assert.deepEqual(codes, [EXIT_CODES.INCOMPLETE]);
	} finally {
		reset();
	}
});

test('POSIX에서는 SIGINT로 dispatch를 끊으면 손자까지 죽고 lock이 남지 않는다', async (context) => {
	// **이것이 detached + 신호 핸들러 묶음의 실제 계약이다.** Windows에서는 다른 프로세스에 SIGINT를
	// 보낼 수 없어(Node가 무조건 종료로 처리) 이 시나리오를 재현할 수 없다 — CI의 ubuntu 러너가 검증한다.
	if (process.platform === 'win32') return context.skip('POSIX 전용 — Windows는 SIGINT를 전달할 수 없다');

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `handoff-interrupt-${process.pid}-`));
	try {
		// codex 대신, 손자를 띄우고 계속 사는 stub을 쓴다. 손자가 marker에 계속 쓰므로 mtime이 멈추면
		// 트리가 죽은 것이다 — "죽이려 시도했다"가 아니라 "실제로 멈췄다"를 본다.
		const marker = path.join(dir, 'alive.txt');
		const grandchild = path.join(dir, 'grandchild.js');
		fs.writeFileSync(grandchild, `const fs = require('node:fs');\nsetInterval(() => fs.writeFileSync(${JSON.stringify(marker)}, String(Date.now())), 50);\n`);
		const stub = path.join(dir, 'codex-stub.js');
		fs.writeFileSync(stub, [
			`require('node:child_process').spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
			"process.stdin.resume();",
			"setInterval(() => {}, 1000);"
		].join('\n'));

		// dispatch를 직접 부르지 않고, handleInterrupt가 등록되는 실제 경로를 태운다.
		const runner = path.join(dir, 'runner.js');
		fs.writeFileSync(runner, [
			`const { installInterruptHandlers, interruptState } = require(${JSON.stringify(path.resolve(__dirname, '..', 'dispatch.js'))});`,
			"const { spawn } = require('node:child_process');",
			`const child = spawn(process.execPath, [${JSON.stringify(stub)}], { stdio: 'ignore', detached: true });`,
			"interruptState.child = child;",
			"interruptState.group = true;",
			"interruptState.lock = { file: 'x' };",
			"installInterruptHandlers(() => { require('node:fs').writeFileSync(" + JSON.stringify(path.join(dir, 'released.txt')) + ", 'ok'); });",
			"process.stdout.write('ready\\n');",
			"setInterval(() => {}, 1000);"
		].join('\n'));

		const proc = spawn(process.execPath, [runner], { stdio: ['ignore', 'pipe', 'pipe'] });
		await new Promise((resolve) => proc.stdout.once('data', resolve));
		for (let i = 0; i < 60 && !fs.existsSync(marker); i += 1) await new Promise((r) => setTimeout(r, 50));
		assert.ok(fs.existsSync(marker), '손자가 먼저 살아 있어야 한다');

		const code = await new Promise((resolve) => {
			proc.once('exit', (value) => resolve(value));
			proc.kill('SIGINT');
		});
		assert.equal(code, EXIT_CODES.INCOMPLETE, 'SIGINT는 INCOMPLETE(5)로 끝나야 한다');
		assert.ok(fs.existsSync(path.join(dir, 'released.txt')), 'lock을 해제해야 한다');

		await new Promise((r) => setTimeout(r, 500));
		const first = fs.statSync(marker).mtimeMs;
		await new Promise((r) => setTimeout(r, 500));
		assert.equal(fs.statSync(marker).mtimeMs, first, '손자가 계속 쓰고 있으면 트리 종료가 안 된 것이다');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
