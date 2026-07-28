const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const DISPATCH_CLI = path.resolve(__dirname, '..', 'dispatch.js');
const TASK_CLI = path.resolve(__dirname, '..', '..', 'task', 'index.js');
const SESSION_ID = '11111111-1111-1111-1111-111111111111';
const TRANSPORT_SENTINEL = 'orchestrator_helper_launch_failed: codex-windows-sandbox-setup.exe program not found';

function runCodexStub() {
	const prompt = fs.readFileSync(0, 'utf8');
	if (process.env.HANDOFF_STUB_MARKER) {
		fs.writeFileSync(process.env.HANDOFF_STUB_MARKER, JSON.stringify({
			args: process.argv.slice(2),
			prompt,
			cwd: process.cwd()
		}, null, 2));
	}
	const mode = process.env.HANDOFF_STUB_MODE || 'success';
	if (mode === 'no-output') return;
	if (mode === 'transport') {
		console.error(TRANSPORT_SENTINEL);
		return;
	}
	if (mode === 'benign-sentinels') {
		// 정상 stdout이 전송 sentinel 문자열을 인용해도 transport로 오분류하면 안 된다(-o 산출물은 더 이상 없음).
		console.log(JSON.stringify({ type: 'item.completed', item: { text: TRANSPORT_SENTINEL } }));
	}
	if (mode === 'events-write-failure') {
		const runsDir = path.join(process.env.HANDOFF_STATE_DIR, 'runs');
		const runDirectory = fs.readdirSync(runsDir, { withFileTypes: true }).find((entry) => entry.isDirectory());
		const eventsFile = path.join(runsDir, runDirectory.name, 'events.jsonl');
		fs.rmSync(eventsFile, { force: true });
		fs.mkdirSync(eventsFile);
		console.log(JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID }));
		return;
	}
	console.log(JSON.stringify({ type: 'thread.started', thread_id: SESSION_ID }));
	if (mode === 'abnormal') {
		process.exitCode = 7;
		return;
	}
	const transition = spawnSync(process.execPath, [TASK_CLI, 'set', 'status=REVIEW'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: process.env,
		windowsHide: true
	});
	if (transition.status !== 0) {
		console.error(transition.stderr);
		process.exitCode = transition.status || 1;
		return;
	}
	if (mode === 'lock-corrupt') {
		// dispatcher가 보유한 lock 파일을 실행 중에 깨뜨린다 → 해제 시 readJson이 STATE_INVALID를 던진다.
		fs.writeFileSync(path.join(process.env.HANDOFF_STATE_DIR, 'dispatch.lock'), '{ 깨진 JSON', 'utf8');
	}
	console.log(JSON.stringify({ type: 'future.event', ignored: true }));
	console.log(JSON.stringify({ type: 'turn.completed', usage: {} }));
}

if (process.argv.includes('--codex-stub')) {
	runCodexStub();
} else {
	const test = require('node:test');
	const assert = require('node:assert/strict');
	const { parseSource } = require('../../task/lib');
	const { decideOutcome, measureRepository } = require('../dispatch');

	function shareSource(options = {}) {
		const status = options.status || 'READY';
		const highRisk = options.highRisk === true;
		return [
			'---',
			'id: dispatch-fixture',
			'status: ' + status,
			'objective: dispatcher subprocess 검증',
			'requester: tester',
			'roles:',
			'  designer: ' + (highRisk ? 'Claude Opus' : 'Claude'),
			'  implementer: Codex',
			'  reviewer: ' + (highRisk ? 'Claude Opus' : 'Claude'),
			'branch: test',
			'designCheckpoint: fixture-checkpoint',
			'issue: null',
			'highRisk: ' + String(highRisk),
			'verification: null',
			'blocked: null',
			'closure: null',
			'updated: 2026-07-20T00:00:00.000Z',
			'---',
			'',
			'# TASK.md — Active Task 상태',
			'',
			'## Active Task',
			'',
			'fixture task',
			'',
			'### 요구사항과 완료 조건',
			'',
			'- dispatcher 동작과 검증을 완료한다.',
			'',
			'### 필독 문서와 불변식',
			'',
			'- AGENTS.md와 상태머신을 따른다.',
			'',
			'### 영향 범위',
			'',
			'- 임시 fixture만 변경한다.',
			'',
			'### 확정된 설계와 미확정 사항',
			'',
			'- stdin JSONL 경로를 사용한다.',
			'',
			'### 구현 및 설계 차이',
			'',
			'- stub이 검증했다.',
			'',
			'### 검증 결과',
			'',
			'- reviewer가 기록한다.',
			'',
			'### Review와 다음 행동',
			'',
			'- **다음 담당자**: Claude',
			'- **다음 행동**: dispatcher 결과 리뷰',
			''
		].join('\n');
	}

	function fixture(options = {}) {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-dispatch-'));
		const shareFile = path.join(root, 'TASK.md');
		const stateDir = path.join(root, 'state');
		const marker = path.join(root, 'stub-marker.json');
		const gitRepository = path.join(root, 'git-repository');
		try {
			execFileSync('git', ['init', '-q', gitRepository], { windowsHide: true });
			fs.writeFileSync(shareFile, shareSource(options), 'utf8');
			return { root, shareFile, stateDir, marker, gitDir: path.join(gitRepository, '.git') };
		} catch (error) {
			fs.rmSync(root, { recursive: true, force: true });
			throw error;
		}
	}

	function environment(item, stubMode = 'success') {
		return {
			...process.env,
			// gitPorcelain은 고정 REPO_ROOT를 측정하되, Git metadata는 fixture가 소유한 임시 저장소에 격리한다.
			GIT_DIR: item.gitDir,
			GIT_WORK_TREE: REPO_ROOT,
			TASK_STATE_FILE: item.shareFile,
			HANDOFF_STATE_DIR: item.stateDir,
			HANDOFF_CODEX_CMD: JSON.stringify([process.execPath, __filename, '--codex-stub']),
			HANDOFF_STUB_MARKER: item.marker,
			HANDOFF_STUB_MODE: stubMode
		};
	}

	function runDispatcher(item, args = [], stubMode = 'success') {
		return spawnSync(process.execPath, [DISPATCH_CLI, ...args], {
			cwd: REPO_ROOT,
			encoding: 'utf8',
			env: environment(item, stubMode),
			timeout: 20_000,
			windowsHide: true
		});
	}

	function taskState(item) {
		return parseSource(fs.readFileSync(item.shareFile, 'utf8')).data;
	}

	function newestResult(item) {
		const runsDir = path.join(item.stateDir, 'runs');
		const files = fs.readdirSync(runsDir)
			.map((name) => path.join(runsDir, name, 'result.json'))
			.filter((file) => fs.existsSync(file))
			.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
		return JSON.parse(fs.readFileSync(files[0], 'utf8'));
	}

	test('신규 위임과 명시 session resume을 stub으로 완주한다', () => {
		const item = fixture();
		try {
			const first = runDispatcher(item);
			assert.equal(first.status, 0, first.stderr + '\n' + first.stdout);
			assert.equal(taskState(item).status, 'REVIEW');
			const marker = JSON.parse(fs.readFileSync(item.marker, 'utf8'));
			assert.equal(marker.cwd, REPO_ROOT);
			const initialArgs = marker.args.slice(marker.args.indexOf('exec'));
			assert.equal(initialArgs[0], 'exec');
			assert.equal(initialArgs.includes('resume'), false);
			assert.equal(initialArgs.at(-1), '-');
			assert.equal(initialArgs.includes('-s'), false);
			assert.equal(initialArgs.includes('--last'), false);
			assert.equal(initialArgs.includes('--dangerously-bypass-approvals-and-sandbox'), false);
			assert.equal(initialArgs[initialArgs.indexOf('-c') + 1], 'sandbox_mode="workspace-write"');
			assert.match(marker.prompt, /set status=REVIEW/);
			const sessions = JSON.parse(fs.readFileSync(path.join(item.stateDir, 'sessions.json'), 'utf8'));
			assert.equal(sessions.sessions[0].sessionId, SESSION_ID);
			const firstReport = newestResult(item);
			assert.equal(firstReport.outcome.success, true);
			assert.equal(firstReport.timeoutMs, 30 * 60 * 1000);

			const resumed = runDispatcher(item, ['--resume']);
			assert.equal(resumed.status, 0, resumed.stderr + '\n' + resumed.stdout);
			assert.equal(taskState(item).status, 'REVIEW');
			const resumeMarker = JSON.parse(fs.readFileSync(item.marker, 'utf8'));
			const resumeArgs = resumeMarker.args.slice(resumeMarker.args.indexOf('exec'));
			assert.deepEqual(resumeArgs.slice(0, 2), ['exec', 'resume']);
			assert.equal(resumeArgs.at(-2), SESSION_ID);
			assert.equal(resumeArgs.at(-1), '-');
			assert.equal(resumeArgs.includes('--last'), false);
			assert.equal(resumeArgs.includes('-s'), false);
			assert.equal(resumeArgs[resumeArgs.indexOf('-c') + 1], 'sandbox_mode="workspace-write"');
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('세션 없는 IMPLEMENTING Task는 --resume에서 새 exec로 crash 복구한다', () => {
		const item = fixture({ status: 'IMPLEMENTING' });
		try {
			assert.equal(fs.existsSync(path.join(item.stateDir, 'sessions.json')), false);
			const result = runDispatcher(item, ['--resume']);
			assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
			assert.equal(taskState(item).status, 'REVIEW');
			const marker = JSON.parse(fs.readFileSync(item.marker, 'utf8'));
			const invocation = marker.args.slice(marker.args.indexOf('exec'));
			assert.equal(invocation[0], 'exec');
			assert.equal(invocation.includes('resume'), false);
			const report = newestResult(item);
			assert.equal(report.mode, 'recovery-new');
			assert.equal(report.sessionId, SESSION_ID);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('세션 없는 REVIEW Task의 --resume은 계속 거부한다', () => {
		const item = fixture({ status: 'REVIEW' });
		try {
			const result = runDispatcher(item, ['--resume']);
			assert.equal(result.status, 2, result.stderr);
			assert.match(result.stderr, /SESSION_NOT_FOUND/);
			assert.equal(fs.existsSync(item.marker), false);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('비READY, highRisk 미승인, 활성 lock 가드를 Codex 호출 전에 거부한다', async (context) => {
		await context.test('비READY', () => {
			const item = fixture({ status: 'IMPLEMENTING' });
			try {
				const result = runDispatcher(item);
				assert.equal(result.status, 2, result.stderr);
				assert.equal(fs.existsSync(item.marker), false);
			} finally {
				fs.rmSync(item.root, { recursive: true, force: true });
			}
		});
		await context.test('highRisk 미승인', () => {
			const item = fixture({ highRisk: true });
			try {
				const result = runDispatcher(item);
				assert.equal(result.status, 2, result.stderr);
				assert.equal(fs.existsSync(item.marker), false);
			} finally {
				fs.rmSync(item.root, { recursive: true, force: true });
			}
		});
		await context.test('활성 lock', () => {
			const item = fixture();
			try {
				fs.mkdirSync(item.stateDir, { recursive: true });
				fs.writeFileSync(path.join(item.stateDir, 'dispatch.lock'), JSON.stringify({
					schemaVersion: 1,
					token: 'active',
					pid: process.pid,
					createdAt: new Date().toISOString(),
					timeoutMs: 60_000
				}));
				const result = runDispatcher(item);
				assert.equal(result.status, 2, result.stderr);
				assert.equal(fs.existsSync(item.marker), false);
			} finally {
				fs.rmSync(item.root, { recursive: true, force: true });
			}
		});
	});

	test('exit 0 무산출과 REVIEW 미도달을 실패로 판정하고 IMPLEMENTING을 유지한다', () => {
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'no-output');
			assert.equal(result.status, 5, result.stderr + '\n' + result.stdout);
			assert.equal(taskState(item).status, 'IMPLEMENTING');
			const report = newestResult(item);
			assert.equal(report.codex.exitCode, 0);
			assert.equal(report.sessionId, null);
			assert.equal(report.outcome.kind, 'review-not-reached');
			assert.match(report.outcome.reason, /REVIEW 미도달 = 실패/);
			assert.ok(fs.existsSync(report.artifacts.events));
			assert.ok(fs.existsSync(report.artifacts.stderr));
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('helper 오류가 exit 0이어도 전송 계층 실패로 보고한다', () => {
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'transport');
			assert.equal(result.status, 4, result.stderr + '\n' + result.stdout);
			assert.equal(taskState(item).status, 'IMPLEMENTING');
			const report = newestResult(item);
			assert.equal(report.codex.exitCode, 0);
			assert.equal(report.outcome.kind, 'transport');
			assert.equal(report.codex.parsed.failureKind, 'transport');
			assert.match(report.outcome.reason, /모델 실패가 아니며/);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('일반 stdout 이벤트의 sentinel은 transport로 오분류하지 않는다', () => {
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'benign-sentinels');
			assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
			const report = newestResult(item);
			assert.equal(report.outcome.kind, 'review-reached');
			assert.equal(report.codex.parsed.failureKind, null);
			assert.equal(report.codex.parsed.transportFailure, null);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('events append 실패(로컬 I/O)를 INTERNAL(artifact)로 보고하고 dispatch lock을 해제한다', () => {
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'events-write-failure');
			assert.equal(result.status, 1, result.stderr + '\n' + result.stdout);
			const report = newestResult(item);
			assert.equal(report.outcome.kind, 'artifact');
			assert.ok(report.codex.artifactError);
			assert.equal(report.codex.spawnError, null);
			assert.equal(fs.existsSync(path.join(item.stateDir, 'dispatch.lock')), false);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('lock 해제 실패는 경고로 남기고 위임 판정 결과를 덮지 않는다', () => {
		// finally의 releaseLock이 그대로 던지면 성공 판정도, 원래 실패 원인도 INTERNAL로 뭉개진다.
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'lock-corrupt');
			assert.equal(result.status, 0, result.stderr + '\n' + result.stdout);
			assert.equal(taskState(item).status, 'REVIEW');
			assert.equal(newestResult(item).outcome.kind, 'review-reached');
			assert.match(result.stderr, /LOCK_RELEASE_FAILED/);
			// 해제하지 못한 lock은 남는다 — 그래서 수동 정리를 경고에 명시한다.
			assert.equal(fs.existsSync(path.join(item.stateDir, 'dispatch.lock')), true);
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('Codex 비정상 종료를 성공으로 해석하지 않는다', () => {
		const item = fixture();
		try {
			const result = runDispatcher(item, [], 'abnormal');
			assert.equal(result.status, 5, result.stderr + '\n' + result.stdout);
			assert.equal(taskState(item).status, 'IMPLEMENTING');
			const report = newestResult(item);
			assert.equal(report.codex.exitCode, 7);
			assert.equal(report.sessionId, SESSION_ID);
			assert.equal(report.outcome.kind, 'abnormal-exit');
		} finally {
			fs.rmSync(item.root, { recursive: true, force: true });
		}
	});

	test('timeout 판정은 REVIEW 상태여도 성공으로 바꾸지 않는다', () => {
		const outcome = decideOutcome({
			timedOut: true,
			parsed: { transportFailure: null, modelFailure: null },
			spawnError: null,
			stdinError: null,
			exitCode: 0,
			signal: null
		}, {
			frontMatterStatus: 'REVIEW',
			taskLintExitCode: 0,
			gitStatusExitCode: 0
		}, 'new', SESSION_ID);
		assert.equal(outcome.success, false);
		assert.equal(outcome.exitCode, 3);
		assert.equal(outcome.kind, 'timeout');
	});

	test('transport 판정은 유지하되 REVIEW 도달 실측을 reason에 덧붙인다', () => {
		// helper 기동 실패는 환경을 보증할 수 없으므로 exit 4가 맞다. 다만 exit 4를 "아무 일도 없었다"로 읽고
		// 그대로 재실행하면 이미 끝난 작업을 중복 수행한다 — 사람이 확인할 근거를 판정문에 남긴다.
		const codex = { timedOut: false, parsed: { transportFailure: { message: 'orchestrator helper 기동 실패' }, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'dispatch-fixture', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0, gitChanges: [] };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.exitCode, 4);
		assert.equal(outcome.kind, 'transport');
		assert.match(outcome.reason, /orchestrator helper 기동 실패/);
		assert.match(outcome.reason, /이미 REVIEW/);
	});

	test('REVIEW에 못 갔지만 작업 트리가 변한 transport 실패도 재실행 전 확인을 알린다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: { message: '전송 실패' }, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'IMPLEMENTING', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0, gitChanges: [' M engine/task/lib.js'] };
		assert.match(decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture').reason, /변경 1건/);
	});

	test('진행 흔적이 없으면 transport reason에 군더더기를 붙이지 않는다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: { message: '전송 실패' }, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'IMPLEMENTING', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0, gitChanges: [] };
		assert.equal(decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture').reason, '전송 실패');
	});

	test('다른 Task ID의 REVIEW는 이 위임의 성공으로 인정하지 않는다(task-changed)', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'other-task', taskLintExitCode: 0, gitStatusExitCode: 0 };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, false);
		assert.equal(outcome.kind, 'task-changed');
	});

	test('같은 Task ID의 REVIEW만 성공으로 인정한다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'dispatch-fixture', taskLintExitCode: 0, gitStatusExitCode: 0 };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, true);
	});

	test('post-run task show 실패는 review-not-reached가 아니라 task-measurement(INTERNAL)로 분류한다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: null, frontMatterTaskId: null, taskShowExitCode: 1, taskLintExitCode: 0, gitStatusExitCode: 0 };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, false);
		assert.equal(outcome.kind, 'task-measurement');
		assert.equal(outcome.exitCode, 1);
	});

	test('로컬 artifact 오류는 후속 stdin transport(EPIPE)보다 우선해 INTERNAL로 분류한다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, artifactError: 'metadata write failure', stdinError: 'write EPIPE', exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'dispatch-fixture', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0 };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.kind, 'artifact');
		assert.equal(outcome.exitCode, 1);
	});

	test('스냅샷 이후 live Task 교체(liveChanged)는 성공으로 인정하지 않는다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'dispatch-fixture', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0, liveChanged: true };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, false);
		assert.equal(outcome.kind, 'task-changed');
	});

	test('스냅샷 생성 실패(snapshotFailed)는 fallback 대신 INTERNAL로 분류한다', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: 'REVIEW', frontMatterTaskId: 'dispatch-fixture', taskShowExitCode: 0, taskLintExitCode: 0, gitStatusExitCode: 0, snapshotFailed: true };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, false);
		assert.equal(outcome.kind, 'task-measurement');
		assert.equal(outcome.exitCode, 1);
	});

	test('measureRepository: 최초 TASK read 실패는 원본 fallback 없이 snapshotFailed로 고정한다', () => {
		const missing = path.join(os.tmpdir(), 'cc-missing-' + process.hrtime.bigint() + '.md');
		const m = measureRepository(missing, process.env);
		assert.equal(m.snapshotFailed, true);
		assert.equal(m.frontMatterStatus, null);
		assert.equal(m.taskShowExitCode, null);
	});

	test('task show가 exit 0이지만 invalid/null(taskShowValid=false)이면 review-not-reached가 아니라 INTERNAL', () => {
		const codex = { timedOut: false, parsed: { transportFailure: null, modelFailure: null }, spawnError: null, artifactError: null, stdinError: null, exitCode: 0, signal: null };
		const measurement = { frontMatterStatus: null, frontMatterTaskId: null, taskShowExitCode: 0, taskShowValid: false, taskLintExitCode: 0, gitStatusExitCode: 0 };
		const outcome = decideOutcome(codex, measurement, 'new', SESSION_ID, 'dispatch-fixture');
		assert.equal(outcome.success, false);
		assert.equal(outcome.kind, 'task-measurement');
		assert.equal(outcome.exitCode, 1);
	});
}
