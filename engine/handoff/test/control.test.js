const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { consumeAbortRequest } = require('../lib');

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
