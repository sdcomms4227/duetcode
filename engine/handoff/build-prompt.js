#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { parseSource } = require('../task/lib');
const { EXIT_CODES, HandoffError, REPO_ROOT, resolveShareFile } = require('./lib');

const ACTIVE_TASK_SECTIONS = [
	'요구사항과 완료 조건',
	'필독 문서와 불변식',
	'영향 범위',
	'확정된 설계와 미확정 사항'
];

// task validate의 meaningful()과 동일 판정: 불릿에서 '- '와 '**label**:'를 걷어낸 값이 모두
// placeholder(없음/미정/TODO/-)면 미완성으로 본다. 그러지 않으면 resume 경로(전환-검증 생략)에서
// 'TODO'/'없음' 같은 미완성 설계로도 Codex가 실행될 수 있다(두 게이트의 placeholder 규칙 불일치).
const PLACEHOLDER_VALUES = new Set(['미정', '없음', 'TODO', '-']);
function sectionIsPlaceholder(content) {
	const meaningful = content.split(/\r?\n/)
		.map((line) => line.replace(/^\s*[-*]\s*/, '').replace(/^\*\*[^*]+\*\*:\s*/, '').trim())
		.filter((value) => value && !PLACEHOLDER_VALUES.has(value));
	return meaningful.length === 0;
}

function extractSection(body, title) {
	const marker = '### ' + title;
	const start = body.indexOf(marker);
	if (start < 0) {
		throw new HandoffError('Active Task 필수 섹션을 찾을 수 없습니다: ' + title, {
			code: 'PROMPT_SECTION_MISSING',
			exitCode: EXIT_CODES.GUARD
		});
	}
	const contentStart = start + marker.length;
	const remaining = body.slice(contentStart);
	const next = remaining.search(/\r?\n### /);
	const content = (next < 0 ? remaining : remaining.slice(0, next)).trim();
	if (!content) {
		throw new HandoffError('Active Task 필수 섹션이 비어 있습니다: ' + title, {
			code: 'PROMPT_SECTION_EMPTY',
			exitCode: EXIT_CODES.GUARD
		});
	}
	if (sectionIsPlaceholder(content)) {
		throw new HandoffError('Active Task 필수 섹션이 아직 미정입니다. 사람이 설계를 완성해야 합니다: ' + title, {
			code: 'PROMPT_SECTION_UNDECIDED',
			exitCode: EXIT_CODES.GUARD
		});
	}
	return marker + '\n\n' + content;
}

// 상태 파일을 프롬프트 표기용 경로로 변환한다. 저장소 안이면 REPO_ROOT 상대경로(정상 핸드오프에서
// basename이 TASK.md면 표기 불변), 밖이면 절대경로를 그대로 표기해 Codex가 대상 파일을 정확히 인지하게 한다.
function taskFileLabel(shareFile) {
	const absolute = path.isAbsolute(shareFile) ? shareFile : path.resolve(REPO_ROOT, shareFile);
	const relative = path.relative(REPO_ROOT, absolute).replaceAll('\\', '/');
	if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
		return absolute.replaceAll('\\', '/');
	}
	return relative;
}

function buildPrompt(options = {}) {
	const shareFile = options.shareFile || resolveShareFile(options.env);
	const taskFile = taskFileLabel(shareFile);
	const source = options.source ?? fs.readFileSync(shareFile, 'utf8');
	const parsed = parseSource(source);
	const task = parsed.data;
	if (!task.id || !task.status) {
		throw new HandoffError('Active Task id/status가 없어 핸드오프 페이로드를 만들 수 없습니다.', {
			code: 'PROMPT_TASK_INVALID',
			exitCode: EXIT_CODES.GUARD
		});
	}
	const sections = ACTIVE_TASK_SECTIONS.map((title) => extractSection(parsed.body, title));

	return [
		'당신은 이 저장소의 Active Task 구현 담당자다.',
		'',
		'작업을 시작하기 전에 저장소 루트의 AGENTS.md, CLAUDE.md, ' + taskFile + '를 각각 끝까지 읽고 모두 따른다.',
		taskFile + '의 Active Task가 이 작업의 단일 소스이며, 아래 발췌는 탐색 보조 정보일 뿐 원문을 대체하지 않는다.',
		'실제 코드·Git·환경이 설계와 충돌하면 실제 상태를 우선하고 근거와 차이를 ' + taskFile + ' 본문에 기록한다.',
		'요구사항·공개 API·보안 정책을 바꾸는 충돌이면 구현을 멈추고 그 사유만 ' + taskFile + ' 본문에 기록한다.',
		'',
		'Active Task 메타데이터:',
		'- id: ' + task.id,
		'- status at payload build: ' + task.status,
		'- objective: ' + task.objective,
		'',
		...sections.flatMap((section) => [section, '']),
		'### 종료 규약',
		'',
		'- 요청된 구현과 로컬 검증을 완료한다.',
		'- ' + taskFile + ' front matter는 직접 편집하지 않는다.',
		'- ' + taskFile + ' 본문 ‘구현 및 설계 차이’에 구현 결과, 실측으로 확정한 사항, 설계 차이와 근거를 기록한다.',
		'- 완료 상태가 확인된 뒤 node tools/task/index.js set status=REVIEW 를 실행한다.',
		'- 종료 보고는 자연어 성공 선언이 아니라 실제 front matter 상태, task lint 결과, Git 변경을 근거로 한다.',
		'',
		'### 금지',
		'',
		'- git commit, git push, release',
		'- DONE 전환',
		'- issue-sync',
		'- record-verification',
		'- approve-partial',
		'- ' + taskFile + ' front matter 직접 편집',
		'- Task 범위 밖 파일 변경',
		'',
		'모든 작업은 저장소 안에서 비대화형으로 수행하고, 승인 대기 상태를 만들지 않는다.'
	].join('\n');
}

function main() {
	process.stdout.write(buildPrompt() + '\n');
}

if (require.main === module) {
	try {
		main();
	} catch (error) {
		console.error('build-prompt: ' + error.message);
		process.exitCode = 1;
	}
}

module.exports = {
	ACTIVE_TASK_SECTIONS,
	buildPrompt,
	extractSection,
	sectionIsPlaceholder,
	taskFileLabel
};
