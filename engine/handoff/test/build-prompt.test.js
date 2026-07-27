const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt } = require('../build-prompt');

function shareSource(sectionValue = '구현 완료 조건과 구체 요구사항') {
	return [
		'---',
		'id: prompt-fixture',
		'status: READY',
		'objective: dispatcher prompt 검증',
		'requester: tester',
		'roles:',
		'  designer: Claude',
		'  implementer: Codex',
		'  reviewer: Claude',
		'branch: test',
		'designCheckpoint: fixture',
		'issue: null',
		'highRisk: false',
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
		'### 요구사항과 완료 조건',
		'',
		'- ' + sectionValue,
		'',
		'### 필독 문서와 불변식',
		'',
		'- docs/contract.md 전체와 상태머신 불변식',
		'',
		'### 영향 범위',
		'',
		'- tools/handoff만 변경',
		'',
		'### 확정된 설계와 미확정 사항',
		'',
		'- stdin 전달과 JSONL 수집 확정',
		'',
		'### 구현 및 설계 차이',
		'',
		'- 구현 담당자가 기록',
		'',
		'### 검증 결과',
		'',
		'- reviewer가 기록',
		'',
		'### Review와 다음 행동',
		'',
		'- **다음 담당자**: Codex',
		'- **다음 행동**: 구현',
		''
	].join('\n');
}

test('Active Task 필수 내용과 종료·금지 계약을 prompt에 포함한다', () => {
	const prompt = buildPrompt({ source: shareSource(), shareFile: 'fixture-TASK.md' });
	for (const required of [
		'AGENTS.md',
		'CLAUDE.md',
		'TASK.md',
		'docs/contract.md',
		'구현 완료 조건과 구체 요구사항',
		'node tools/task/index.js set status=REVIEW',
		'구현 및 설계 차이',
		'git commit',
		'DONE 전환',
		'issue-sync',
		'record-verification',
		'approve-partial',
		'front matter 직접 편집'
	]) {
		assert.ok(prompt.includes(required), required);
	}
});

test('필수 섹션에 미정 플레이스홀더만 남으면 위임을 거부한다', () => {
	assert.throws(
		() => buildPrompt({ source: shareSource('미정'), shareFile: 'fixture-TASK.md' }),
		(error) => error.code === 'PROMPT_SECTION_UNDECIDED' && /사람이 설계를 완성/.test(error.message)
	);
});

test('TODO·없음·- 플레이스홀더도 task validate와 동일하게 위임을 거부한다', () => {
	for (const placeholder of ['TODO', '없음', '-']) {
		assert.throws(
			() => buildPrompt({ source: shareSource(placeholder), shareFile: 'fixture-TASK.md' }),
			(error) => error.code === 'PROMPT_SECTION_UNDECIDED',
			placeholder
		);
	}
});

test('커스텀 상태 파일 경로를 프롬프트 표기에 반영한다', () => {
	const prompt = buildPrompt({ source: shareSource(), shareFile: 'sub/dir/TASK.md' });
	assert.ok(prompt.includes('sub/dir/TASK.md'), '상대경로가 프롬프트에 포함되어야 한다');
});

test('상태 파일이 저장소 밖이면 절대경로로 표기한다', () => {
	const prompt = buildPrompt({ source: shareSource(), shareFile: '../outside/TASK.md' });
	assert.ok(prompt.includes('/outside/TASK.md'), '저장소 밖 경로는 절대경로로 프롬프트에 표기되어야 한다');
});
