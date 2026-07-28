const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRunDirectory, pruneRuns, runRetention, DEFAULT_RUN_RETENTION } = require('../lib');

function stateDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-retention-'));
}

function seed(runsDirectory, count) {
	for (let index = 0; index < count; index += 1) {
		const name = '2026-01-01T00-00-' + String(index).padStart(2, '0') + '-000Z-1-aaaaaaaa';
		fs.mkdirSync(path.join(runsDirectory, name), { recursive: true });
		fs.writeFileSync(path.join(runsDirectory, name, 'prompt.md'), 'x', 'utf8');
	}
}

test('새 run을 만들 때 오래된 run부터 보존 개수까지 지운다', () => {
	// run 산출물에는 프롬프트와 모델 출력 전문이 남는다. 무제한 누적은 용량보다 잔존 자체가 위험이다.
	const dir = stateDir();
	try {
		const runs = path.join(dir, 'runs');
		seed(runs, 6);
		const created = createRunDirectory(dir, { HANDOFF_RUN_RETENTION: '3' });
		const remaining = fs.readdirSync(runs).sort();
		assert.equal(remaining.length, 3);
		assert.equal(created.pruned.length, 4);
		// 방금 만든 run은 가장 최신이므로 항상 남는다.
		assert.ok(remaining.includes(created.runId));
		// 가장 오래된 것부터 지운다.
		assert.equal(remaining.includes('2026-01-01T00-00-00-000Z-1-aaaaaaaa'), false);
		assert.ok(remaining.includes('2026-01-01T00-00-05-000Z-1-aaaaaaaa'));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('보존 개수 이하면 아무것도 지우지 않는다', () => {
	const dir = stateDir();
	try {
		seed(path.join(dir, 'runs'), 2);
		assert.deepEqual(createRunDirectory(dir, { HANDOFF_RUN_RETENTION: '10' }).pruned, []);
		assert.equal(fs.readdirSync(path.join(dir, 'runs')).length, 3);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('HANDOFF_RUN_RETENTION 기본값과 유효성 검사', () => {
	assert.equal(runRetention({}), DEFAULT_RUN_RETENTION);
	assert.equal(runRetention({ HANDOFF_RUN_RETENTION: '' }), DEFAULT_RUN_RETENTION);
	assert.equal(runRetention({ HANDOFF_RUN_RETENTION: '1' }), 1);
	for (const bad of ['0', '-1', '2.5', 'many']) {
		assert.throws(() => runRetention({ HANDOFF_RUN_RETENTION: bad }), /1 이상의 정수/, bad);
	}
});

test('runs 디렉터리가 없으면 조용히 넘어간다', () => {
	const dir = stateDir();
	try {
		assert.deepEqual(pruneRuns(path.join(dir, 'runs'), 5), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('디렉터리가 아닌 항목은 정리 대상으로 세지 않는다', () => {
	const dir = stateDir();
	try {
		const runs = path.join(dir, 'runs');
		seed(runs, 2);
		fs.writeFileSync(path.join(runs, 'stray-note.txt'), 'x', 'utf8');
		assert.deepEqual(pruneRuns(runs, 2), []);
		assert.ok(fs.existsSync(path.join(runs, 'stray-note.txt')));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
