#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { buildPrompt } = require('./build-prompt');
// 프로세스 트리 종료는 task/lib에 있다. verify(스모크 서버)와 dispatch(codex)가 같은 문제를 풀기 때문에
// 구현이 한 벌이어야 한다 — 의존 방향은 기존과 같다(handoff → task).
const { terminateProcessTree, resolveSpawn } = require('../task/lib');
const {
	EXIT_CODES,
	HandoffError,
	REPO_ROOT,
	REPO_ROOT_SOURCE,
	STATE_SCHEMA_VERSION,
	acquireLock,
	clearSession,
	consumeAbortRequest,
	createRunDirectory,
	getSession,
	gitPorcelain,
	idempotencyKey,
	lintTask,
	nowIso,
	parseCodexCommand,
	recordSession,
	redactText,
	StreamRedactor,
	redactJsonl,
	releaseLock,
	resolveShareFile,
	resolveStateDir,
	runTask,
	showTask,
	transitionTask,
	writeJson
} = require('./lib');
const { ResultParser } = require('./parse-result');

const DEFAULT_TIMEOUT_MINUTES = 30;
const SANDBOX_CONFIG = 'sandbox_mode="workspace-write"';
const LINE_ASSEMBLER_CAP = 16 * 1024 * 1024;

function usage() {
	return [
		'사용법: duet-handoff [--resume] [--high-risk-approved] [--timeout-min N]  (npm run handoff -- ...)',
		'',
		'--resume              기록된 thread_id를 명시해 REVIEW 보완 또는 IMPLEMENTING crash 복구',
		'--high-risk-approved  highRisk Task의 사람/Opus 게이트 통과 표시',
		'--timeout-min N       전체 Codex 실행 제한(기본 30분)'
	].join('\n');
}

function parseArgs(args = process.argv.slice(2)) {
	const options = {
		resume: false,
		highRiskApproved: false,
		timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
		help: false
	};
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];
		if (argument === '--resume') options.resume = true;
		else if (argument === '--high-risk-approved') options.highRiskApproved = true;
		else if (argument === '--help' || argument === '-h') options.help = true;
		else if (argument === '--timeout-min') {
			const raw = args[index + 1];
			const value = Number(raw);
			if (!raw || !Number.isFinite(value) || value <= 0) {
				throw new HandoffError('--timeout-min에는 0보다 큰 숫자가 필요합니다.', {
					code: 'USAGE',
					exitCode: EXIT_CODES.GUARD
				});
			}
			options.timeoutMinutes = value;
			index += 1;
		} else {
			throw new HandoffError('알 수 없는 옵션입니다: ' + argument, {
				code: 'USAGE',
				exitCode: EXIT_CODES.GUARD
			});
		}
	}
	return options;
}

function determineMode(task, options, stateDir) {
	if (task.highRisk && !options.highRiskApproved) {
		throw new HandoffError('highRisk Task는 --high-risk-approved 없이 위임할 수 없습니다.', {
			code: 'HIGH_RISK_APPROVAL_REQUIRED',
			exitCode: EXIT_CODES.GUARD
		});
	}
	if (!options.resume) {
		if (task.status !== 'READY') {
			throw new HandoffError('신규 위임은 READY Task에서만 가능합니다. 현재 상태: ' + task.status, {
				code: 'NON_READY',
				exitCode: EXIT_CODES.GUARD
			});
		}
		return { mode: 'new', recordedSession: null, transitionRequired: true };
	}

	const recordedSession = getSession(stateDir, task.id);
	if (!recordedSession?.sessionId) {
		// pre-session 실패(codex 미기동·전송 실패)로 세션 없이 IMPLEMENTING에 갇힌 Task는 TRANSITIONS에
		// IMPLEMENTING→READY가 없어 신규 위임으로도 되돌릴 수 없다. 현재 IMPLEMENTING 상태에서 새 Codex
		// 스레드를 시작해 복구한다(전환 불필요). 그 외 상태의 --resume은 기록된 세션이 필요하다.
		if (task.status === 'IMPLEMENTING') {
			return { mode: 'recovery-new', recordedSession: null, transitionRequired: false };
		}
		throw new HandoffError('--resume에는 해당 Task의 기록된 thread_id가 필요합니다.', {
			code: 'SESSION_NOT_FOUND',
			exitCode: EXIT_CODES.GUARD
		});
	}
	if (task.status === 'REVIEW') {
		return { mode: 'resume-review', recordedSession, transitionRequired: true };
	}
	if (task.status === 'IMPLEMENTING') {
		return { mode: 'resume-recovery', recordedSession, transitionRequired: false };
	}
	throw new HandoffError('--resume은 REVIEW 또는 lock 없는 IMPLEMENTING Task에서만 가능합니다. 현재 상태: ' + task.status, {
		code: 'RESUME_STATUS_INVALID',
		exitCode: EXIT_CODES.GUARD
	});
}

function buildCodexInvocation(command, mode, sessionId) {
	const executable = command[0];
	const prefix = command.slice(1);
	// codex에 -o(파일 출력)를 주지 않는다: 최종 메시지 원문을 디스크에 직접 쓰면 강제종료 시 잔존한다.
	// 모델 최종 출력은 정화된 events.jsonl에 남으며, 별도 last-message 산출물은 만들지 않는다.
	let args;
	if (mode === 'new' || mode === 'recovery-new') {
		args = [...prefix, 'exec', '--json', '-c', SANDBOX_CONFIG, '-'];
	} else {
		args = [...prefix, 'exec', 'resume', '--json', '-c', SANDBOX_CONFIG, sessionId, '-'];
	}
	return { executable, args };
}

// 신호로 끊길 때 정리해야 하는 것. 신호는 프로세스 전역 사건이라 모듈 수준에 둔다.
// dispatch()가 lock을, executeCodex()가 child를 등록하고 각자 끝날 때 지운다.
const interruptState = { lock: null, child: null, group: false, installed: false, releaseLock: null };

// SIGINT/SIGTERM/SIGHUP에서 codex 트리를 죽이고 lock을 풀고 나간다.
//
// **왜 필요한가**: codex를 POSIX에서 detached로 띄우면(트리 종료를 위해 필요하다) 자식이 자기 세션으로
// 분리되어 터미널의 Ctrl-C를 **받지 않는다.** 핸들러가 없으면 dispatch만 죽고 codex는 고아가 되어
// 저장소를 계속 수정한다 — 고치려던 것보다 나쁘다. 그래서 detached와 이 핸들러는 한 묶음이다.
//
// 덤으로 기존 결함도 사라진다: Node의 기본 SIGINT 처리는 finally를 실행하지 않아 dispatch.lock이
// 남았다(다음 실행이 lockIsStale의 pid 생존 검사로 회수하긴 했다). 이제 즉시 해제한다.
//
// 핸들러 안에서는 무엇도 던지지 않는다. 여기서 예외가 나면 정리 자체가 무산된다.
// exit을 주입할 수 있게 둔다 — 그러지 않으면 이 함수를 테스트하는 순간 테스트 러너가 죽는다.
function handleInterrupt(signal, exit = process.exit) {
	try {
		if (interruptState.child) terminateProcessTree(interruptState.child, { group: interruptState.group });
	} catch { /* 트리가 이미 사라졌다 */ }
	try {
		if (interruptState.lock && interruptState.releaseLock) interruptState.releaseLock(interruptState.lock);
	} catch { /* lock 파일이 손상됐으면 stale 검사가 회수한다 */ }
	interruptState.child = null;
	interruptState.lock = null;
	try {
		process.stderr.write(`handoff: ${signal}으로 중단했습니다. Codex를 종료하고 lock을 해제했으며 Task는 IMPLEMENTING으로 남습니다.\n`);
	} catch { /* stderr가 닫혔을 수 있다 */ }
	// 결과 판정을 만들 수 없으므로 INCOMPLETE(5)로 끝낸다 — abort 제어 파일 경로와 같은 코드다.
	return exit(EXIT_CODES.INCOMPLETE);
}
function installInterruptHandlers(release = releaseLock) {
	if (interruptState.installed) return;
	interruptState.installed = true;
	interruptState.releaseLock = release;
	// Windows에서 SIGTERM은 전달되지 않지만 등록 자체는 무해하다.
	for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
		try { process.on(signal, () => handleInterrupt(signal)); } catch { /* 플랫폼이 지원하지 않는 신호 */ }
	}
}

function executeCodex(invocation, options) {
	return new Promise((resolve) => {
		const parser = new ResultParser();
		fs.writeFileSync(options.eventsFile, '', { encoding: 'utf8', mode: 0o600 });
		fs.writeFileSync(options.stderrFile, '', { encoding: 'utf8', mode: 0o600 });
		const events = new StreamRedactor((text) => fs.appendFileSync(options.eventsFile, text, 'utf8'), options.env, 64 * 1024 * 1024,
			(text, env) => text.split('\n').map((line) => line ? redactJsonl(line, env) : line).join('\n'));
		const stderrLog = new StreamRedactor((text) => fs.appendFileSync(options.stderrFile, text, 'utf8'), options.env);
		const stdoutDecoder = new StringDecoder('utf8');
		const stderrDecoder = new StringDecoder('utf8');
		let stdoutBuffer = '';
		let stderrOverlap = '';
		let spawnError = null;
		let artifactError = null;
		let stdinError = null;
		let timedOut = false;
		let aborted = false;
		let termination = null;
		let settled = false;
		let timeoutTimer = null;
		let abortPollTimer = null;
		let hardStopTimer = null;
		let lastRecordedSession = null;

		const recordSpawnError = (error, child, kind) => {
			if (kind === 'artifact') artifactError = artifactError || error;
			else spawnError = spawnError || error;
			if (child && !settled && !termination) termination = terminateProcessTree(child, { group: interruptState.group });
		};

		// stdout 조립기 append+상한검사를 data 이벤트와 EOF tail이 공유한다(fail-closed면 false).
		const appendStdout = (text, child) => {
			stdoutBuffer += text;
			if (Buffer.byteLength(stdoutBuffer, 'utf8') > LINE_ASSEMBLER_CAP) {
				stdoutBuffer = '';
				recordSpawnError(new Error('stdout 라인 어셈블러 상한 초과: fail-closed.'), child, 'artifact');
				return false;
			}
			return true;
		};

		const consumeLine = (line, child) => {
			try {
				events.push(line + '\n');
				// 완결된 앞부분을 바로 내보낸다 — 실행 중 관찰 가능하고 강제종료 시에도 그때까지의 로그가 남는다.
				events.drain();
				parser.push(line);
			} catch (error) {
				recordSpawnError(error, child, 'artifact');
				return;
			}
			if (parser.sessionId && parser.sessionId !== lastRecordedSession) {
				lastRecordedSession = parser.sessionId;
				try {
					options.onSession(parser.sessionId);
				} catch (error) {
					recordSpawnError(new Error('session state 기록 실패: ' + error.message), child, 'artifact');
				}
			}
		};

		const finish = (code, signal, child) => {
			if (settled) return;
			settled = true;
			interruptState.child = null;
			clearTimeout(timeoutTimer);
			if (abortPollTimer) clearInterval(abortPollTimer);
			if (hardStopTimer) clearTimeout(hardStopTimer);
			if (appendStdout(stdoutDecoder.end(), null) && stdoutBuffer) consumeLine(stdoutBuffer, null);
			try { events.flush(); } catch (error) { artifactError = artifactError || error; }
			try {
				const tail = stderrDecoder.end();
				if (tail) { stderrLog.push(tail); parser.inspectText(stderrOverlap + tail); }
				stderrLog.flush();
			} catch (error) { artifactError = artifactError || error; }
			let parsed;
			try {
				parsed = parser.finish();
			} catch (error) {
				artifactError = artifactError || error;
				parsed = new ResultParser().finish();
			}
			resolve({
				pid: child?.pid || null,
				exitCode: code,
				signal,
				timedOut,
				aborted,
				termination,
				spawnError: spawnError?.message || null,
				artifactError: artifactError?.message || null,
				stdinError: stdinError?.message || null,
				parsed
			});
		};

		let child;
		try {
			// resolveSpawn이 Windows의 .cmd/.bat을 실행 가능한 형태로 바꾼다. npm으로 설치한 codex는
			// codex.cmd이고, shell 없는 spawn은 확장자를 .exe만 붙여 찾으므로 그대로는 ENOENT로 죽었다.
			// .exe·절대 경로·POSIX에서는 아무것도 바꾸지 않는다(engine/task/test/spawn.test.js가 고정).
			const spawnable = resolveSpawn(invocation.executable, invocation.args);
			// POSIX에서는 detached로 띄워 codex를 프로세스 그룹 리더로 만든다. 그래야 종료할 때 그룹째로
			// 죽여 codex가 실행한 도구·셸까지 정리된다 — 안 하면 timeout·abort 후에도 자손이 남아
			// 저장소를 계속 수정할 수 있다(abort가 약속한 것을 절반만 지키는 상태였다).
			// Windows는 taskkill /T가 트리를 처리하고, detached는 새 콘솔을 뜻하므로 쓰지 않는다.
			// detached는 터미널의 Ctrl-C가 codex에 닿지 않게 만들므로 installInterruptHandlers와 한 묶음이다.
			const detached = process.platform !== 'win32';
			child = spawn(spawnable.executable, spawnable.args, {
				detached,
				cwd: REPO_ROOT,
				env: {
					...options.env,
					TASK_STATE_FILE: options.shareFile,
					HANDOFF_STATE_DIR: options.stateDir
				},
				shell: false,
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
				...spawnable.options
			});
			interruptState.child = child;
			interruptState.group = detached;
		} catch (error) {
			spawnError = error;
			resolve({
				pid: null,
				exitCode: null,
				signal: null,
				timedOut: false,
				aborted: false,
				termination: null,
				spawnError: error.message,
				artifactError: null,
				stdinError: null,
				parsed: parser.finish()
			});
			return;
		}

		child.stdout.on('data', (chunk) => {
			if (!appendStdout(stdoutDecoder.write(chunk), child)) return;
			let newline;
			while ((newline = stdoutBuffer.indexOf('\n')) >= 0) {
				const line = stdoutBuffer.slice(0, newline).replace(/\r$/, '');
				stdoutBuffer = stdoutBuffer.slice(newline + 1);
				consumeLine(line, child);
			}
		});
		child.stderr.on('data', (chunk) => {
			try {
				const text = stderrDecoder.write(chunk);
				if (!text) return;
				stderrLog.push(text);
				stderrLog.drain();
				parser.inspectText(stderrOverlap + text);
				stderrOverlap = (stderrOverlap + text).slice(-256);
			} catch (error) {
				recordSpawnError(error, child, 'artifact');
			}
		});
		child.stdin.on('error', (error) => {
			stdinError = error;
		});
		child.once('error', (error) => {
			recordSpawnError(error, null);
		});
		child.once('close', (code, signal) => finish(code, signal, child));

		timeoutTimer = setTimeout(() => {
			timedOut = true;
			termination = terminateProcessTree(child, { group: interruptState.group });
			hardStopTimer = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				child.stdin.destroy();
				child.unref();
				finish(null, 'TIMEOUT', child);
			}, 5000);
		}, options.timeoutMs);
		abortPollTimer = setInterval(() => {
			if (settled || termination) return;
			let requested = false;
			try {
				requested = consumeAbortRequest(options.stateDir, options.runId);
			} catch (error) {
				recordSpawnError(new Error('중단 제어 파일 검사 실패: ' + error.message), child, 'artifact');
				return;
			}
			if (!requested) return;
			aborted = true;
			termination = terminateProcessTree(child, { group: interruptState.group });
			hardStopTimer = setTimeout(() => {
				child.stdout.destroy();
				child.stderr.destroy();
				child.stdin.destroy();
				child.unref();
				finish(null, 'ABORTED', child);
			}, 5000);
		}, 250);
		let onSpawnOk = true;
		try {
			options.onSpawn(child.pid);
		} catch (error) {
			onSpawnOk = false;
			recordSpawnError(error, child, 'artifact');
		}
		if (onSpawnOk) {
			try {
				child.stdin.end(options.prompt, 'utf8');
			} catch (error) {
				recordSpawnError(error, child);
			}
		} else {
			try { child.stdin.destroy(); } catch { /* onSpawn 실패 시 stdin 미전송 → EPIPE 캐스케이드 방지 */ }
		}
	});
}

function measureRepository(shareFile, env) {
	// TOCTOU 방지: TASK 파일을 저장소 밖(os.tmpdir)에 스냅샷해 show·lint가 동일 바이트를 측정하고(저장소 git 오염 없음),
	// 측정 후 live 파일이 그대로인지 재확인한다(스냅샷 이후 A→B 교체 방지). 스냅샷 생성 실패는 fallback 대신 INTERNAL.
	let liveBefore = null;
	let readFailed = false;
	try { liveBefore = fs.readFileSync(shareFile); } catch { readFailed = true; }
	let snapshotPath = null;
	let snapshotOk = false;
	if (!readFailed) {
		snapshotPath = path.join(os.tmpdir(), 'cc-measure-' + process.pid + '-' + process.hrtime.bigint() + '.tmp');
		try {
			fs.writeFileSync(snapshotPath, liveBefore, { mode: 0o600 });
			snapshotOk = true;
		} catch {
			snapshotOk = false;
		}
	}
	try {
		const git = gitPorcelain();
		const gitFields = { gitStatusExitCode: git.status, gitChanges: git.changes.map((line) => redactText(line, env)) };
		// 최초 read 실패 또는 snapshot write 실패 → 원본 fallback 없이 실패 신호(fail-open 금지). decideOutcome이 INTERNAL 고정.
		if (readFailed || !snapshotOk) {
			return { frontMatterStatus: null, frontMatterTaskId: null, taskShowExitCode: null, taskLintExitCode: null, ...gitFields, snapshotFailed: true, liveChanged: false };
		}
		const shown = runTask(['show'], { shareFile: snapshotPath, env });
		let task = null;
		if (shown.status === 0 && !shown.error) {
			try {
				task = JSON.parse(shown.stdout);
			} catch {
				task = null;
			}
		}
		const taskShowValid = shown.status === 0 && task != null && task.status != null;
		const lint = lintTask({ shareFile: snapshotPath, env });
		let liveChanged = false;
		try {
			liveChanged = !liveBefore.equals(fs.readFileSync(shareFile));
		} catch {
			liveChanged = true;
		}
		return {
			frontMatterStatus: task?.status || null,
			frontMatterTaskId: task?.id || null,
			taskShowValid,
			taskShowExitCode: shown.status,
			taskLintExitCode: lint.status,
			...gitFields,
			snapshotFailed: false,
			liveChanged
		};
	} finally {
		// write 도중 실패한 부분 temp까지 제거(경로를 별도 변수로 추적).
		if (snapshotPath) { try { fs.unlinkSync(snapshotPath); } catch { /* best-effort */ } }
	}
}

// transport·timeout은 "환경을 보증할 수 없다"는 판정이라 측정보다 앞선다. 그런데 그 exit code가 "아무 일도
// 일어나지 않았다"로 읽히면, 실제로는 완료된 작업을 그대로 재실행해 중복 수행하게 된다. 판정은 그대로 두되
// 실측 사실을 reason에 덧붙여, 재실행 전에 확인할 근거를 사람에게 준다(측정 자체는 result.json에 이미 있다).
function progressHint(measurement) {
	if (!measurement || measurement.snapshotFailed) return '';
	if (measurement.frontMatterStatus === 'REVIEW') {
		return ' [실측: Active Task가 이미 REVIEW다. 재실행 전에 result.json의 measurement를 확인할 것 — 작업이 끝나 있을 수 있다.]';
	}
	const changes = Array.isArray(measurement.gitChanges) ? measurement.gitChanges.length : 0;
	if (changes > 0) return ' [실측: 작업 트리에 변경 ' + changes + '건이 남아 있다. 재실행 전에 확인할 것.]';
	return '';
}

function decideOutcome(codex, measurement, mode, sessionId, expectedTaskId) {
	const principle = 'Codex exit code·자연어만 신뢰하지 않고 REVIEW 전환, task lint, Git 실측을 함께 판정한다.';
	if (codex.timedOut) {
		return { success: false, exitCode: EXIT_CODES.TIMEOUT, kind: 'timeout', reason: 'timeout: REVIEW 성공으로 해석하지 않으며 상태를 자동 전환하지 않습니다.' + progressHint(measurement), principle };
	}
	if (codex.aborted) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'aborted', reason: '현재 run ID와 일치하는 중단 요청으로 Codex 프로세스를 종료했습니다. 상태를 자동 전환하지 않습니다.' + progressHint(measurement), principle };
	}
	if (codex.parsed.transportFailure) {
		return { success: false, exitCode: EXIT_CODES.TRANSPORT, kind: 'transport', reason: codex.parsed.transportFailure.message + progressHint(measurement), principle };
	}
	if (codex.artifactError) {
		return { success: false, exitCode: EXIT_CODES.INTERNAL, kind: 'artifact', reason: 'dispatcher 로그·상태 기록 실패(로컬 원인 우선, 모델·전송 실패 아님): ' + codex.artifactError, principle };
	}
	if (codex.spawnError || codex.stdinError) {
		return { success: false, exitCode: EXIT_CODES.TRANSPORT, kind: 'transport', reason: 'Codex 프로세스 전송/기동 실패: ' + (codex.spawnError || codex.stdinError), principle };
	}
	if (codex.exitCode !== 0 || codex.signal) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'abnormal-exit', reason: 'Codex가 비정상 종료했습니다. REVIEW 도달 여부와 별개로 성공 처리하지 않습니다.', principle };
	}
	if (codex.parsed.modelFailure) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'model', reason: codex.parsed.modelFailure.message, principle };
	}
	if (measurement.snapshotFailed) {
		return { success: false, exitCode: EXIT_CODES.INTERNAL, kind: 'task-measurement', reason: 'TASK 스냅샷 생성 실패로 일관 측정을 못 해 성공 판정을 보류합니다.', principle };
	}
	if (measurement.taskShowExitCode != null && measurement.taskShowExitCode !== 0) {
		return { success: false, exitCode: EXIT_CODES.INTERNAL, kind: 'task-measurement', reason: 'post-run task show 실측 실패로 성공 판정을 보류합니다(측정/상태 오류, 모델·전송 실패 아님).', principle };
	}
	if (measurement.taskShowValid === false) {
		return { success: false, exitCode: EXIT_CODES.INTERNAL, kind: 'task-measurement', reason: 'task show가 exit 0이지만 출력이 invalid/status 누락이라 성공 판정을 보류합니다.', principle };
	}
	if (measurement.frontMatterStatus !== 'REVIEW') {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'review-not-reached', reason: 'REVIEW 미도달 = 실패. exit 0 또는 자연어 성공 메시지는 성공 근거가 아닙니다.', principle };
	}
	if (expectedTaskId != null && measurement.frontMatterTaskId !== expectedTaskId) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'task-changed', reason: 'Codex 실행 중 Active Task가 다른 Task로 바뀌었습니다. 다른 Task의 REVIEW를 이 위임의 성공으로 인정하지 않습니다.', principle };
	}
	if (measurement.liveChanged) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'task-changed', reason: '측정(스냅샷) 이후 live Active Task가 바뀌어 성공 판정을 보류합니다.', principle };
	}
	if (measurement.taskLintExitCode !== 0) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'task-lint', reason: 'REVIEW에 도달했지만 task lint가 실패했습니다.', principle };
	}
	if (measurement.gitStatusExitCode !== 0) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'git-measurement', reason: 'Git 변경 상태를 실측하지 못했습니다.', principle };
	}
	if ((mode === 'new' || mode === 'recovery-new') && !sessionId) {
		return { success: false, exitCode: EXIT_CODES.INCOMPLETE, kind: 'session-missing', reason: 'thread.started.thread_id를 수집하지 못해 성공 처리하지 않습니다.', principle };
	}
	return { success: true, exitCode: EXIT_CODES.SUCCESS, kind: 'review-reached', reason: 'REVIEW 도달, task lint 통과, Git 상태 실측을 확인했습니다.', principle };
}

function artifactPaths(runDirectory) {
	return {
		prompt: path.join(runDirectory, 'prompt.md'),
		events: path.join(runDirectory, 'events.jsonl'),
		stderr: path.join(runDirectory, 'stderr.log'),
		metadata: path.join(runDirectory, 'metadata.json'),
		result: path.join(runDirectory, 'result.json')
	};
}

async function dispatch(options, runtime = {}) {
	const env = { ...process.env, ...runtime.env };
	const shareFile = resolveShareFile(env);
	const stateDir = resolveStateDir(env);
	const initialTask = showTask({ shareFile, env });
	const mode = determineMode(initialTask, options, stateDir);
	const timeoutMs = Math.round(options.timeoutMinutes * 60 * 1000);
	const key = idempotencyKey(initialTask);
	const lock = acquireLock(stateDir, {
		taskId: initialTask.id,
		idempotencyKey: key,
		initialStatus: initialTask.status,
		timeoutMs
	});
	// lock을 잡은 직후에 등록한다. 신호는 이 다음 어느 시점에도 올 수 있고, 그때 lock이 남으면
	// 다음 실행이 stale 판정을 기다려야 한다.
	interruptState.lock = lock;
	installInterruptHandlers(runtime.releaseLock || releaseLock);
	let run = null;
	let artifacts = null;

	try {
		run = createRunDirectory(stateDir, env);
		artifacts = artifactPaths(run.directory);
		const lockedTask = showTask({ shareFile, env });
		if (idempotencyKey(lockedTask) !== key) {
			throw new HandoffError('lock 획득 중 Active Task가 바뀌어 위임을 중단했습니다.', {
				code: 'TASK_CHANGED',
				exitCode: EXIT_CODES.GUARD
			});
		}
		if (!mode.transitionRequired) {
			const preflight = lintTask({ shareFile, env });
			if (preflight.status !== 0) {
				throw new HandoffError('resume 전 task lint 실패: 불완전한 설계로 위임할 수 없습니다.', {
					code: 'RESUME_LINT_FAILED',
					exitCode: EXIT_CODES.GUARD,
					details: preflight.stderr && preflight.stderr.trim()
				});
			}
		}
		const prompt = buildPrompt({ shareFile, env });
		fs.writeFileSync(artifacts.prompt, redactText(prompt, env) + '\n', {
			encoding: 'utf8',
			mode: 0o600
		});

		if (mode.mode === 'new' || mode.mode === 'recovery-new') clearSession(stateDir, initialTask.id);
		if (mode.transitionRequired) {
			const transition = transitionTask('IMPLEMENTING', { shareFile, env });
			if (transition.status !== 0 || transition.error) {
				throw new HandoffError('IMPLEMENTING 전환이 실패해 Codex 호출 자격을 얻지 못했습니다.', {
					code: 'TASK_TRANSITION_FAILED',
					exitCode: EXIT_CODES.GUARD,
					details: transition.error?.message || transition.stderr.trim()
				});
			}
		}
		const implementingTask = showTask({ shareFile, env });
		if (implementingTask.id !== initialTask.id || implementingTask.status !== 'IMPLEMENTING') {
			throw new HandoffError('IMPLEMENTING 전환 실측이 일치하지 않아 Codex를 호출하지 않습니다.', {
				code: 'TASK_TRANSITION_UNCONFIRMED',
				exitCode: EXIT_CODES.GUARD
			});
		}

		const command = parseCodexCommand(env);
		const recordedSessionId = mode.recordedSession?.sessionId || null;
		const invocation = buildCodexInvocation(command, mode.mode, recordedSessionId);
		const startedAt = nowIso();
		const metadata = {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: run.runId,
			taskId: initialTask.id,
			idempotencyKey: key,
			mode: mode.mode,
			pid: null,
			startedAt,
			timeoutMs,
			workingDirectory: REPO_ROOT,
			// 이번 실행이 지운 과거 run 수. 조용히 사라지지 않도록 기록에 남긴다.
			prunedRuns: run.pruned.length,
			// 이전 run을 겨냥한 채 남아 있던 중단 요청을 걷어냈는지. 요청이 왜 안 먹었는지 추적할 근거다.
			staleAbortCleared: run.staleAbortCleared,
			// 'cwd'면 git 해석에 실패해 폴백했다는 뜻이다. 잘못된 root로 조용히 동작하지 않도록 기록에 남긴다.
			repoRootSource: REPO_ROOT_SOURCE,
			sandboxMode: 'workspace-write',
			command: [invocation.executable, ...invocation.args].map((value) => redactText(value, env))
		};
		writeJson(artifacts.metadata, metadata);

		const codex = await executeCodex(invocation, {
			env,
			shareFile,
			stateDir,
			prompt,
			timeoutMs,
			runId: run.runId,
			eventsFile: artifacts.events,
			stderrFile: artifacts.stderr,
			onSpawn(pid) {
				metadata.pid = pid;
				writeJson(artifacts.metadata, metadata);
			},
			onSession(sessionId) {
				recordSession(stateDir, {
					taskId: initialTask.id,
					sessionId,
					runId: run.runId
				});
			}
		});
		const sessionId = codex.parsed.sessionId || recordedSessionId;
		if (sessionId && codex.parsed.sessionId) {
			recordSession(stateDir, {
				taskId: initialTask.id,
				sessionId,
				runId: run.runId
			});
		}
		const measurement = measureRepository(shareFile, env);
		const outcome = decideOutcome(codex, measurement, mode.mode, sessionId, initialTask.id);
		const report = {
			schemaVersion: STATE_SCHEMA_VERSION,
			runId: run.runId,
			taskId: initialTask.id,
			mode: mode.mode,
			startedAt,
			finishedAt: nowIso(),
			timeoutMs,
			sessionId,
			codex,
			measurement,
			outcome,
			artifacts
		};
		writeJson(artifacts.result, report);
		return { exitCode: outcome.exitCode, report };
	} catch (error) {
		if (run && artifacts) {
			const report = {
				schemaVersion: STATE_SCHEMA_VERSION,
				runId: run.runId,
				taskId: initialTask.id,
				mode: mode.mode,
				finishedAt: nowIso(),
				measurement: measureRepository(shareFile, env),
				outcome: {
					success: false,
					exitCode: error.exitCode ?? EXIT_CODES.INTERNAL,
					kind: error.code || 'internal',
					reason: error.message,
					principle: 'Codex 호출 전후 상태를 실측하며 실패 시 자동 재시도·DONE 전환을 하지 않습니다.'
				},
				artifacts
			};
			try {
				writeJson(artifacts.result, report);
			} catch {
				// The original failure remains authoritative.
			}
			error.handoffReport = report;
		}
		throw error;
	} finally {
		interruptState.lock = null;
		// lock 파일이 손상되면 releaseLock이 STATE_INVALID를 던진다. finally에서 그대로 새어 나가면
		// 원래 실패 원인(성공 시에는 판정 결과까지)을 덮어 INTERNAL로 뭉갠다 — 해제 실패는 경고로만 남긴다.
		try {
			releaseLock(lock);
		} catch (releaseError) {
			console.error('handoff[LOCK_RELEASE_FAILED]: lock 해제 실패(수동 정리 필요): ' + releaseError.message);
		}
	}
}

async function main() {
	let options;
	try {
		options = parseArgs();
		if (options.help) {
			console.log(usage());
			return;
		}
		const result = await dispatch(options);
		console.log(JSON.stringify(result.report, null, 2));
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error('handoff[' + (error.code || 'ERROR') + ']: ' + error.message);
		if (error.handoffReport) console.error(JSON.stringify(error.handoffReport, null, 2));
		else console.error(usage());
		process.exitCode = error.exitCode ?? EXIT_CODES.INTERNAL;
	}
}

if (require.main === module) main();

module.exports = {
	DEFAULT_TIMEOUT_MINUTES,
	SANDBOX_CONFIG,
	buildCodexInvocation,
	decideOutcome,
	determineMode,
	dispatch,
	measureRepository,
	parseArgs,
	terminateProcessTree,
	handleInterrupt,
	installInterruptHandlers,
	interruptState,
	usage
};
