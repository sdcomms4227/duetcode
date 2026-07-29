const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeAbortRequest, clearStaleAbort, createRunDirectory } = require('../lib');

test('abort 요청은 현재 run ID가 정확히 일치할 때만 소비한다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-abort-'));
	const abortFile = path.join(stateDir, 'abort');
	try {
		fs.writeFileSync(abortFile, JSON.stringify({ runId: 'old-run' }), 'utf8');
		assert.equal(consumeAbortRequest(stateDir, 'current-run'), false);
		assert.equal(fs.existsSync(abortFile), true);

		fs.writeFileSync(abortFile, JSON.stringify({ runId: 'current-run' }), 'utf8');
		assert.equal(consumeAbortRequest(stateDir, 'current-run'), true);
		assert.equal(fs.existsSync(abortFile), false);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test('없거나 손상된 abort 파일은 실행을 중단하지 않는다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-abort-invalid-'));
	const abortFile = path.join(stateDir, 'abort');
	try {
		assert.equal(consumeAbortRequest(stateDir, 'current-run'), false);
		fs.writeFileSync(abortFile, '{ invalid', 'utf8');
		assert.equal(consumeAbortRequest(stateDir, 'current-run'), false);
		assert.equal(fs.existsSync(abortFile), true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test('새 run을 만들 때 이전 run을 겨냥한 채 남은 abort 요청을 걷어낸다', () => {
	// consumeAbortRequest는 runId가 다르면 파일을 남긴다. 지우는 주체가 없으면 그 요청은 영구히 남아
	// 이후 모든 run이 250ms마다 읽기만 하는 쓰레기가 된다. 새 run 시작 시점의 abort는 정의상 stale이다.
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-abort-stale-'));
	const abortFile = path.join(stateDir, 'abort');
	try {
		fs.writeFileSync(abortFile, JSON.stringify({ runId: 'run-that-already-finished' }), 'utf8');
		const created = createRunDirectory(stateDir, {});
		assert.equal(created.staleAbortCleared, true);
		assert.equal(fs.existsSync(abortFile), false);
		// 걷어낸 뒤 새 run의 abort 판정은 자기 runId에만 반응한다.
		assert.equal(consumeAbortRequest(stateDir, created.runId), false);

		// 남은 요청이 없으면 정리했다고 보고하지 않는다.
		assert.equal(createRunDirectory(stateDir, {}).staleAbortCleared, false);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test('clearStaleAbort는 요청이 없어도 실패하지 않는다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-abort-clear-'));
	try {
		assert.equal(clearStaleAbort(stateDir), false);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
