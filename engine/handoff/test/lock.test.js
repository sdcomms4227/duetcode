const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { acquireLock, releaseLock } = require('../lib');

test('동시 lock은 한 실행만 획득한다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-lock-'));
	try {
		const first = acquireLock(stateDir, {
			taskId: 'fixture',
			idempotencyKey: 'one',
			timeoutMs: 60_000
		});
		assert.throws(
			() => acquireLock(stateDir, {
				taskId: 'fixture',
				idempotencyKey: 'two',
				timeoutMs: 60_000
			}),
			(error) => error.code === 'LOCKED'
		);
		assert.equal(releaseLock(first), true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test('timeout이 지났고 PID가 죽은 stale lock만 회수한다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-stale-'));
	const lockFile = path.join(stateDir, 'dispatch.lock');
	try {
		fs.writeFileSync(lockFile, JSON.stringify({
			schemaVersion: 1,
			token: 'stale-owner',
			pid: 999999,
			createdAt: '2026-07-20T00:00:00.000Z',
			timeoutMs: 1_000
		}));
		const recovered = acquireLock(stateDir, {
			taskId: 'fixture',
			idempotencyKey: 'recovered',
			timeoutMs: 60_000
		}, {
			nowMs: Date.parse('2026-07-20T00:01:00.000Z'),
			processAlive: () => false
		});
		assert.notEqual(recovered.owner.token, 'stale-owner');
		assert.equal(releaseLock(recovered), true);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});

test('timeout이 지나도 PID가 살아 있으면 lock을 회수하지 않는다', () => {
	const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-live-lock-'));
	const lockFile = path.join(stateDir, 'dispatch.lock');
	try {
		fs.writeFileSync(lockFile, JSON.stringify({
			schemaVersion: 1,
			token: 'live-owner',
			pid: process.pid,
			createdAt: '2026-07-20T00:00:00.000Z',
			timeoutMs: 1_000
		}));
		assert.throws(
			() => acquireLock(stateDir, {
				taskId: 'fixture',
				idempotencyKey: 'must-not-recover',
				timeoutMs: 60_000
			}, {
				nowMs: Date.parse('2026-07-20T00:01:00.000Z'),
				processAlive: () => true
			}),
			(error) => error.code === 'LOCKED'
		);
	} finally {
		fs.rmSync(stateDir, { recursive: true, force: true });
	}
});
