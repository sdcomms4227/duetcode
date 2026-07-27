const test = require('node:test');
const assert = require('node:assert/strict');
const { parseJsonl } = require('../parse-result');

test('thread.started.thread_id를 추출하고 미지 이벤트를 무시한다', () => {
	const summary = parseJsonl([
		JSON.stringify({ type: 'thread.started', thread_id: '11111111-1111-1111-1111-111111111111' }),
		JSON.stringify({ type: 'future.event', payload: { schema: 2 } }),
		JSON.stringify({ type: 'turn.completed', usage: {} }),
		'not-json'
	].join('\n'));
	assert.equal(summary.sessionId, '11111111-1111-1111-1111-111111111111');
	assert.equal(summary.eventCount, 3);
	assert.equal(summary.unknownEventCount, 1);
	assert.equal(summary.invalidLineCount, 1);
	assert.equal(summary.failureKind, null);
});

test('sandbox helper 오류를 exit code와 무관한 전송 계층 실패로 분류한다', () => {
	const helper = parseJsonl(JSON.stringify({
		type: 'error',
		message: 'orchestrator_helper_launch_failed: codex-windows-sandbox-setup.exe program not found'
	}));
	assert.equal(helper.failureKind, 'transport');
	assert.deepEqual(helper.transportFailure.codes, ['ORCHESTRATOR_HELPER_LAUNCH_FAILED']);
	assert.equal(helper.modelFailure, null);

	const logon = parseJsonl('', {
		additionalText: 'CreateProcessWithLogonW failed: 2'
	});
	assert.equal(logon.failureKind, 'transport');
	assert.deepEqual(logon.transportFailure.codes, ['CREATE_PROCESS_WITH_LOGON_FAILED']);
	assert.match(logon.transportFailure.message, /모델 실패가 아니며/);
});

test('일반 turn.failed는 모델 실패로 별도 분류한다', () => {
	const summary = parseJsonl(JSON.stringify({
		type: 'turn.failed',
		error: { message: 'model unavailable' }
	}));
	assert.equal(summary.failureKind, 'model');
	assert.equal(summary.transportFailure, null);
	assert.equal(summary.modelFailure.count, 1);
});

test('transport sentinel은 stderr와 error/turn.failed 이벤트에서만 감지한다', () => {
	const sentinel = 'orchestrator_helper_launch_failed: helper missing';
	const ordinaryEvent = parseJsonl(JSON.stringify({
		type: 'item.completed',
		item: { text: sentinel }
	}));
	assert.equal(ordinaryEvent.failureKind, null);
	assert.equal(ordinaryEvent.transportFailure, null);

	const arbitraryStdout = parseJsonl(sentinel);
	assert.equal(arbitraryStdout.invalidLineCount, 1);
	assert.equal(arbitraryStdout.failureKind, null);

	const failedEvent = parseJsonl(JSON.stringify({
		type: 'turn.failed',
		error: { message: sentinel }
	}));
	assert.equal(failedEvent.failureKind, 'transport');
	assert.deepEqual(failedEvent.transportFailure.codes, ['ORCHESTRATOR_HELPER_LAUNCH_FAILED']);
});
