const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TASK_CLI = path.join(REPO_ROOT, 'tools', 'task', 'index.js');
const DEFAULT_STATE_DIR = path.join(__dirname, 'state');
const STATE_SCHEMA_VERSION = 1;

const EXIT_CODES = Object.freeze({
	SUCCESS: 0,
	INTERNAL: 1,
	GUARD: 2,
	TIMEOUT: 3,
	TRANSPORT: 4,
	INCOMPLETE: 5
});

class HandoffError extends Error {
	constructor(message, options = {}) {
		super(message);
		this.name = 'HandoffError';
		this.code = options.code || 'HANDOFF_ERROR';
		this.exitCode = options.exitCode ?? EXIT_CODES.INTERNAL;
		this.details = options.details || null;
	}
}

function nowIso() {
	return new Date().toISOString();
}

function resolveFromRepo(value) {
	return path.isAbsolute(value) ? value : path.resolve(REPO_ROOT, value);
}

function resolveShareFile(env = process.env) {
	return resolveFromRepo(env.TASK_STATE_FILE || 'TASK.md');
}

function resolveStateDir(env = process.env) {
	return resolveFromRepo(env.HANDOFF_STATE_DIR || DEFAULT_STATE_DIR);
}

function ensureDirectory(directory) {
	fs.mkdirSync(directory, { recursive: true });
}

function writeJson(file, value) {
	ensureDirectory(path.dirname(file));
	const temporary = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
	fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', {
		encoding: 'utf8',
		mode: 0o600
	});
	fs.renameSync(temporary, file);
}

function readJson(file, fallback) {
	try {
		return JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (error) {
		if (error.code === 'ENOENT' && fallback !== undefined) return fallback;
		throw new HandoffError('상태 파일을 읽을 수 없습니다: ' + file, {
			code: 'STATE_INVALID',
			details: error.message
		});
	}
}

function runTask(args, options = {}) {
	const shareFile = options.shareFile || resolveShareFile(options.env);
	const result = spawnSync(process.execPath, [TASK_CLI, ...args], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		env: { ...process.env, ...options.env, TASK_STATE_FILE: shareFile },
		maxBuffer: 10 * 1024 * 1024,
		windowsHide: true
	});
	return {
		status: result.status,
		signal: result.signal,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		error: result.error || null
	};
}

function showTask(options = {}) {
	const result = runTask(['show'], options);
	if (result.status !== 0 || result.error) {
		throw new HandoffError('Active Task 상태를 읽지 못했습니다.', {
			code: 'TASK_SHOW_FAILED',
			details: result.error?.message || result.stderr.trim()
		});
	}
	try {
		return JSON.parse(result.stdout);
	} catch (error) {
		throw new HandoffError('task show 출력이 유효한 JSON이 아닙니다.', {
			code: 'TASK_SHOW_INVALID',
			details: error.message
		});
	}
}

function transitionTask(target, options = {}) {
	return runTask(['set', 'status=' + target], options);
}

function lintTask(options = {}) {
	return runTask(['lint'], options);
}

function gitPorcelain() {
	const result = spawnSync('git', ['status', '--porcelain'], {
		cwd: REPO_ROOT,
		encoding: 'utf8',
		maxBuffer: 10 * 1024 * 1024,
		windowsHide: true
	});
	return {
		status: result.status,
		stdout: result.stdout || '',
		stderr: result.stderr || '',
		error: result.error || null,
		changes: (result.stdout || '').split(/\r?\n/).filter(Boolean)
	};
}

function idempotencyKey(task) {
	return crypto.createHash('sha256')
		.update(JSON.stringify([task.id, task.status, task.updated]))
		.digest('hex');
}

function processIsAlive(pid) {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error.code === 'EPERM';
	}
}

function readLock(lockFile) {
	return readJson(lockFile);
}

function lockIsStale(lock, options = {}) {
	const currentTime = options.nowMs ?? Date.now();
	const alive = options.processAlive || processIsAlive;
	const createdAt = Date.parse(lock?.createdAt);
	const timeoutMs = Number(lock?.timeoutMs);
	if (!Number.isFinite(createdAt) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return false;
	if (!Number.isInteger(lock?.pid) || lock.pid <= 0) return false;
	return currentTime - createdAt > timeoutMs && !alive(lock.pid);
}

function createLockFile(lockFile, metadata) {
	const owner = {
		schemaVersion: STATE_SCHEMA_VERSION,
		token: crypto.randomUUID(),
		pid: process.pid,
		createdAt: nowIso(),
		...metadata
	};
	let descriptor;
	try {
		descriptor = fs.openSync(lockFile, 'wx', 0o600);
		fs.writeFileSync(descriptor, JSON.stringify(owner, null, 2) + '\n', 'utf8');
		fs.fsyncSync(descriptor);
		return owner;
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

function acquireLock(stateDir, metadata, options = {}) {
	ensureDirectory(stateDir);
	const lockFile = path.join(stateDir, 'dispatch.lock');
	try {
		const owner = createLockFile(lockFile, metadata);
		return { lockFile, owner };
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
	}

	const existing = readLock(lockFile);
	if (!lockIsStale(existing, options)) {
		throw new HandoffError('다른 dispatcher가 lock을 보유하고 있습니다.', {
			code: 'LOCKED',
			exitCode: EXIT_CODES.GUARD,
			details: existing
		});
	}

	const reclaimFile = lockFile + '.reclaim';
	let reclaimDescriptor;
	try {
		try {
			reclaimDescriptor = fs.openSync(reclaimFile, 'wx', 0o600);
		} catch (error) {
			if (error.code === 'EEXIST') {
				throw new HandoffError('stale lock 회수가 이미 진행 중입니다.', {
					code: 'LOCKED',
					exitCode: EXIT_CODES.GUARD
				});
			}
			throw error;
		}
		const latest = readLock(lockFile);
		if (!lockIsStale(latest, options)) {
			throw new HandoffError('lock 상태가 바뀌어 stale 회수를 중단했습니다.', {
				code: 'LOCKED',
				exitCode: EXIT_CODES.GUARD,
				details: latest
			});
		}
		fs.unlinkSync(lockFile);
	} finally {
		if (reclaimDescriptor !== undefined) fs.closeSync(reclaimDescriptor);
		try {
			fs.unlinkSync(reclaimFile);
		} catch (error) {
			if (error.code !== 'ENOENT') throw error;
		}
	}

	try {
		const owner = createLockFile(lockFile, metadata);
		return { lockFile, owner };
	} catch (error) {
		if (error.code === 'EEXIST') {
			throw new HandoffError('stale lock 회수 직후 다른 dispatcher가 lock을 획득했습니다.', {
				code: 'LOCKED',
				exitCode: EXIT_CODES.GUARD
			});
		}
		throw error;
	}
}

function releaseLock(lock) {
	if (!lock) return false;
	let current;
	try {
		current = readLock(lock.lockFile);
	} catch (error) {
		if (error.details && /ENOENT/.test(error.details)) return false;
		throw error;
	}
	if (current.token !== lock.owner.token) return false;
	fs.unlinkSync(lock.lockFile);
	return true;
}

function createRunDirectory(stateDir) {
	const runId = nowIso().replace(/[:.]/g, '-') + '-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
	const directory = path.join(stateDir, 'runs', runId);
	ensureDirectory(directory);
	return { runId, directory };
}

function sessionsFile(stateDir) {
	return path.join(stateDir, 'sessions.json');
}

function loadSessions(stateDir) {
	const empty = { schemaVersion: STATE_SCHEMA_VERSION, sessions: [] };
	const state = readJson(sessionsFile(stateDir), empty);
	if (state.schemaVersion !== STATE_SCHEMA_VERSION || !Array.isArray(state.sessions)) {
		throw new HandoffError('sessions.json 스키마가 지원되지 않습니다.', {
			code: 'STATE_INVALID'
		});
	}
	return state;
}

function getSession(stateDir, taskId) {
	return loadSessions(stateDir).sessions.find((entry) => entry.taskId === taskId) || null;
}

function clearSession(stateDir, taskId) {
	const state = loadSessions(stateDir);
	const retained = state.sessions.filter((item) => item.taskId !== taskId);
	if (retained.length === state.sessions.length) return false;
	state.sessions = retained;
	writeJson(sessionsFile(stateDir), state);
	return true;
}

function recordSession(stateDir, entry) {
	const state = loadSessions(stateDir);
	state.sessions = state.sessions.filter((item) => item.taskId !== entry.taskId);
	state.sessions.push({
		taskId: entry.taskId,
		sessionId: entry.sessionId,
		runId: entry.runId,
		updatedAt: nowIso()
	});
	writeJson(sessionsFile(stateDir), state);
}

function parseCodexCommand(env = process.env) {
	const raw = env.HANDOFF_CODEX_CMD;
	if (!raw) {
		if (process.platform === 'win32' && env.LOCALAPPDATA) {
			const installedLauncher = path.join(env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
			if (fs.existsSync(installedLauncher)) return [installedLauncher];
		}
		return ['codex'];
	}
	if (!raw.trim().startsWith('[')) return [raw];
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new HandoffError('HANDOFF_CODEX_CMD JSON 배열을 해석할 수 없습니다.', {
			code: 'CODEX_COMMAND_INVALID',
			details: error.message
		});
	}
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((value) => typeof value !== 'string' || value.length === 0)) {
		throw new HandoffError('HANDOFF_CODEX_CMD는 실행 파일과 선택 인자를 담은 JSON 문자열 배열이어야 합니다.', {
			code: 'CODEX_COMMAND_INVALID'
		});
	}
	return parsed;
}

function sensitiveEnvironmentValues(env = process.env) {
	return Object.entries(env)
		.filter(([key, value]) => /TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH|COOKIE|CREDENTIAL|PRIVATE_?KEY/i.test(key)
			&& typeof value === 'string' && value.length >= 6)
		.map(([, value]) => value)
		.sort((left, right) => right.length - left.length);
}

function redactText(value, env = process.env) {
	let text = String(value ?? '');
	for (const secret of sensitiveEnvironmentValues(env)) {
		const normalized = secret.replace(/\r\n?/g, '\n');
		const variants = new Set([secret, normalized, normalized.replace(/\n/g, '\r\n'), normalized.trim()]);
		for (const variant of variants) {
			if (variant.length < 6) continue;
			text = text.split(variant).join('[REDACTED]');
			// JSON 등으로 개행이 이스케이프된 형태(예: PEM 키의 실제 개행 → \n)도 함께 마스킹한다.
			const escaped = variant.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r/g, '\\r').replace(/\n/g, '\\n');
			if (escaped !== variant) text = text.split(escaped).join('[REDACTED]');
		}
	}
	text = text
		.replace(/-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g, '[REDACTED]')
		.replace(/\b([\w.-]{0,64}(?:secret|token|passwd|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|cookie|set[_-]?cookie|authorization)[\w.-]{0,64})(\s*[=:]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n]+)/gi, (whole, key, sep, val) => {
			// 종결된 인용값이면 인용부호를 유지, 아니면(미종결·공백 포함 unquoted) 줄 끝까지 마스킹.
			const q = (val[0] === '"' || val[0] === "'") && val.length >= 2 && val[val.length - 1] === val[0] ? val[0] : '';
			return key + sep + q + '[REDACTED]' + q;
		})
		.replace(/(['"][\w.-]{0,64}(?:secret|token|passwd|password|passphrase|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|cookie|set[_-]?cookie|authorization)[\w.-]{0,64}['"]\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n]+)/gi, (whole, pre, val) => {
			// 종결 인용값이면 인용부호 유지, 아니면(미종결) 줄 끝까지 마스킹.
			const q = (val[0] === '"' || val[0] === "'") && val.length >= 2 && val[val.length - 1] === val[0] ? val[0] : '';
			return pre + q + '[REDACTED]' + q;
		})
		.replace(/\bsk-[A-Za-z0-9_-]{10,}\b/g, '[REDACTED]')
		.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
		.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '[REDACTED]')
		.replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, '[REDACTED]')
		.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, '[REDACTED]')
		.replace(/\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{2,}){2}/g, '[REDACTED]')
		.replace(/([a-zA-Z][\w+.-]{0,32}:\/\/)[^/\s:@]+:[^/\s@]+@/g, '$1[REDACTED]@')
		.replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
		.replace(/\bBasic\s+[A-Za-z0-9+/=_-]{3,}/gi, 'Basic [REDACTED]');
	return text;
}

function sanitizeFile(file, env = process.env) {
	try {
		const redacted = redactText(fs.readFileSync(file, 'utf8'), env);
		const temporary = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
		fs.writeFileSync(temporary, redacted, { encoding: 'utf8', mode: 0o600 });
		fs.renameSync(temporary, file);
		return true;
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
}

// codex가 raw로 쓴 파일을 읽어 마스킹본을 destination에 원자적으로 쓰고, 성공 여부와 무관하게 원문(source)은
// 반드시 제거한다(디스크에 원문을 남기지 않는다). last-message처럼 codex가 최종 경로에 원문을 직접 쓰지 않도록,
// codex에는 raw 경로를 주고 dispatch가 이 함수로 최종본을 만든다.
function redactToFile(source, destination, env = process.env) {
	let raw;
	try {
		raw = fs.readFileSync(source, 'utf8');
	} catch (error) {
		if (error.code === 'ENOENT') return false;
		throw error;
	}
	try {
		const temporary = destination + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp';
		fs.writeFileSync(temporary, redactText(raw, env), { encoding: 'utf8', mode: 0o600 });
		fs.renameSync(temporary, destination);
	} finally {
		try { fs.unlinkSync(source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
	}
	return true;
}

// JSONL 이벤트를 semantic하게 마스킹한다: 파싱해 모든 문자열 필드를 decoded 상태에서 redact하고 재직렬화한다.
// password=\"...\"처럼 JSON 이스케이프된 원문도 필드 단위로 걸러지므로 정규식을 무한확장할 필요가 없다.
// 파싱 불가(비-JSON) 라인은 raw 텍스트 redaction으로 폴백한다.
const SENSITIVE_TERMS = new Set(['secret', 'token', 'password', 'passwd', 'passphrase', 'credential', 'credentials', 'cookie', 'auth', 'authorization', 'apikey', 'accesskey', 'secretkey', 'privatekey', 'clientsecret', 'bearer']);
function isSensitiveKey(key) {
	// key를 구분자·camelCase 경계로 분해해 세그먼트 단위 정확 매칭한다(부분문자열 오탐 방지: author의 'auth'는 제외, cookie/passphrase는 포함).
	const parts = String(key).split(/[_.\-\s/]+|(?<=[a-z0-9])(?=[A-Z])/).map((p) => p.toLowerCase()).filter(Boolean);
	for (let i = 0; i < parts.length; i += 1) {
		if (SENSITIVE_TERMS.has(parts[i])) return true;
		if (i + 1 < parts.length && SENSITIVE_TERMS.has(parts[i] + parts[i + 1])) return true; // apiKey→api+key 등 인접 결합
	}
	return false;
}
function redactDeep(value, env, parentKey) {
	// 부모 key가 민감하면 값의 타입·내용과 무관하게 통째로 마스킹한다(structured credential 필드 누출 방지).
	if (parentKey != null && isSensitiveKey(parentKey)) return '[REDACTED]';
	if (typeof value === 'string') return redactText(value, env);
	if (Array.isArray(value)) return value.map((item) => redactDeep(item, env, parentKey));
	if (value && typeof value === 'object') {
		const out = {};
		for (const key of Object.keys(value)) out[key] = redactDeep(value[key], env, key);
		return out;
	}
	return value;
}
function redactJsonl(line, env = process.env) {
	const trimmed = line.trim();
	if (!trimmed) return line;
	let parsed;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		return redactText(line, env);
	}
	return JSON.stringify(redactDeep(parsed, env));
}

// 스트리밍 로그를 안전하게 마스킹한다. 한 run의 출력을 모아 flush에서 완전한 문맥(멀티라인 포함)으로 redact하고,
// byte 상한을 넘으면 부분 방출(경계 누출 위험) 대신 fail-closed로 잠근다(latch). redactFn으로 라인별 semantic 전략 주입.
class StreamRedactor {
	constructor(sink, env = process.env, maxBytes = 64 * 1024 * 1024, redactFn = redactText) {
		this.sink = sink;
		this.env = env;
		this.maxBytes = maxBytes;
		this.redactFn = redactFn;
		this.buffer = '';
		this.bytes = 0;
		this.failed = false;
	}
	push(text) {
		if (this.failed) throw new Error('StreamRedactor fail-closed: 상한 초과 후 영구 잠금 상태입니다.');
		if (!text) return;
		this.buffer += text;
		this.bytes += Buffer.byteLength(text, 'utf8'); // 증분만 계산(전체 buffer 재계산은 push당 O(n) → 누적 O(n²))
		if (this.bytes > this.maxBytes) {
			this.buffer = '';
			this.failed = true;
			throw new Error('StreamRedactor 버퍼 상한(' + this.maxBytes + 'B) 초과: 안전한 부분 방출이 불가하여 fail-closed로 잠급니다.');
		}
	}
	flush() {
		if (this.failed) throw new Error('StreamRedactor fail-closed: 상한 초과 후 영구 잠금 상태입니다.');
		if (!this.buffer) return;
		this.sink(this.redactFn(this.buffer, this.env));
		this.buffer = '';
		this.bytes = 0;
	}
}

module.exports = {
	DEFAULT_STATE_DIR,
	EXIT_CODES,
	HandoffError,
	REPO_ROOT,
	STATE_SCHEMA_VERSION,
	TASK_CLI,
	acquireLock,
	clearSession,
	createRunDirectory,
	ensureDirectory,
	getSession,
	gitPorcelain,
	idempotencyKey,
	lintTask,
	loadSessions,
	lockIsStale,
	nowIso,
	parseCodexCommand,
	processIsAlive,
	recordSession,
	redactText,
	releaseLock,
	resolveShareFile,
	resolveStateDir,
	runTask,
	StreamRedactor,
	redactJsonl,
	redactToFile,
	sanitizeFile,
	showTask,
	transitionTask,
	writeJson
};
