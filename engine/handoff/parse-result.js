#!/usr/bin/env node
const fs = require('node:fs');

const KNOWN_EVENT_TYPES = new Set([
	'thread.started',
	'turn.started',
	'turn.completed',
	'turn.failed',
	'item.started',
	'item.updated',
	'item.completed',
	'error'
]);

const TRANSPORT_FAILURES = [
	{
		code: 'ORCHESTRATOR_HELPER_LAUNCH_FAILED',
		pattern: /orchestrator_helper_launch_failed/i
	},
	{
		code: 'CREATE_PROCESS_WITH_LOGON_FAILED',
		pattern: /CreateProcessWithLogonW failed/i
	}
];

function detectTransportFailure(value) {
	const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
	const codes = TRANSPORT_FAILURES
		.filter((candidate) => candidate.pattern.test(text))
		.map((candidate) => candidate.code);
	if (codes.length === 0) return null;
	return {
		kind: 'transport',
		codes,
		message: 'Codex 전송 계층 실패: Windows sandbox helper 실행이 무산됐습니다. '
			+ '이는 모델 실패가 아니며 dispatcher는 helper 파일을 자동 복사하거나 복구하지 않습니다.'
	};
}

class ResultParser {
	constructor() {
		this.eventCount = 0;
		this.unknownEventCount = 0;
		this.invalidLineCount = 0;
		this.sessionId = null;
		this.transportCodes = new Set();
		this.modelFailureEventTypes = [];
	}

	inspectText(value) {
		const transportFailure = detectTransportFailure(value);
		for (const code of transportFailure?.codes || []) this.transportCodes.add(code);
		return transportFailure;
	}

	push(line) {
		const raw = String(line ?? '').trim();
		if (!raw) return null;

		let event;
		try {
			event = JSON.parse(raw);
		} catch {
			this.invalidLineCount += 1;
			return null;
		}

		this.eventCount += 1;
		if (!KNOWN_EVENT_TYPES.has(event.type)) {
			this.unknownEventCount += 1;
			return event;
		}
		if (event.type === 'thread.started' && typeof event.thread_id === 'string' && event.thread_id) {
			this.sessionId = event.thread_id;
		}
		// 전송 계층 센티넬은 Codex 자체 오류 이벤트(error/turn.failed)에서만 신뢰한다. 임의의 정상 stdout이
		// 그 문자열을 인용해도 transport로 오분류하지 않는다(stderr는 executeCodex가 별도 inspectText로 검사).
		if (event.type === 'turn.failed' || event.type === 'error') {
			if (!this.inspectText(raw)) this.modelFailureEventTypes.push(event.type);
		}
		return event;
	}

	finish(additionalText = '') {
		this.inspectText(additionalText);
		const transportFailure = this.transportCodes.size > 0 ? {
			kind: 'transport',
			codes: [...this.transportCodes],
			message: 'Codex 전송 계층 실패: Windows sandbox helper 실행이 무산됐습니다. '
				+ '이는 모델 실패가 아니며 dispatcher는 helper 파일을 자동 복사하거나 복구하지 않습니다.'
		} : null;
		const modelFailure = !transportFailure && this.modelFailureEventTypes.length > 0 ? {
			kind: 'model',
			count: this.modelFailureEventTypes.length,
			eventTypes: [...new Set(this.modelFailureEventTypes)],
			message: 'Codex JSONL이 모델/turn 실패 이벤트를 보고했습니다.'
		} : null;
		return {
			sessionId: this.sessionId,
			eventCount: this.eventCount,
			unknownEventCount: this.unknownEventCount,
			invalidLineCount: this.invalidLineCount,
			failureKind: transportFailure ? 'transport' : modelFailure ? 'model' : null,
			transportFailure,
			modelFailure
		};
	}
}

function parseJsonl(source, options = {}) {
	const parser = new ResultParser();
	for (const line of String(source ?? '').split(/\r?\n/)) parser.push(line);
	return parser.finish(options.additionalText);
}

function main(args = process.argv.slice(2)) {
	const jsonlFile = args[0];
	if (!jsonlFile) {
		console.error('사용법: node tools/handoff/parse-result.js <events.jsonl> [stderr.log]');
		process.exitCode = 1;
		return;
	}
	const jsonl = fs.readFileSync(jsonlFile, 'utf8');
	const stderr = args[1] ? fs.readFileSync(args[1], 'utf8') : '';
	console.log(JSON.stringify(parseJsonl(jsonl, { additionalText: stderr }), null, 2));
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error('parse-result: ' + error.message);
		process.exitCode = 1;
	}
}

module.exports = {
	KNOWN_EVENT_TYPES,
	ResultParser,
	TRANSPORT_FAILURES,
	detectTransportFailure,
	parseJsonl
};
