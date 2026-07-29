const test = require('node:test');
const assert = require('node:assert/strict');
const { buildPrompt, sectionIsPlaceholder } = require('../build-prompt');
const { meaningful } = require('../../task/lib');

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
		'npm run task -- set status=REVIEW',
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

test('본문을 문자열 치환으로 갈아끼우지 말라는 지침을 포함한다', () => {
	// '$`'가 문서 앞부분 전체로 치환돼 TASK.md가 복제된 사고가 있었다. lint가 이제 손상을 잡지만,
	// 애초에 손상을 만들지 않게 하는 건 프롬프트 몫이다.
	const prompt = buildPrompt({ source: shareSource(), shareFile: 'fixture-TASK.md' });
	assert.match(prompt, /문자열 치환 API로 본문을 갈아끼우지 않는다/);
	assert.ok(prompt.includes('$`'), '특수 토큰을 구체적으로 알려야 한다');
	assert.match(prompt, /task -- lint 로 문서가 온전한지 확인/);
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

test('placeholder 판정이 task lint와 정확히 일치한다', () => {
	// 규칙이 두 벌이던 시절 실제로 갈려 있었다: 불릿 없는 산문 섹션을 build-prompt는 통과시키고
	// lint는 거부했다. 두 게이트가 같은 함수를 보도록 묶었으니, 대표 입력에서 판정이 어긋나면 실패한다.
	const cases = [
		'- 실제 요구사항',
		'- **확정**: 실제 값',
		'- 미정',
		'- 없음',
		'- TODO',
		'- -',
		'불릿 없이 산문만 적은 섹션',
		'- 미정\n- 실제 값',
		''
	];
	for (const content of cases) {
		const body = `### 요구사항과 완료 조건\n\n${content}\n`;
		assert.equal(
			sectionIsPlaceholder(content),
			!meaningful(body, '요구사항과 완료 조건'),
			`판정 불일치: ${JSON.stringify(content)}`
		);
	}
});

test('불릿 없는 산문 섹션은 두 게이트 모두 거부한다', () => {
	// 위 일치 검사가 "둘 다 통과"로 만족되지 않도록, 갈렸던 그 입력의 방향을 못박는다.
	const prose = '요구사항을 불릿 없이 산문으로만 적었다';
	assert.equal(sectionIsPlaceholder(prose), true);
	// 픽스처는 값 앞에 '- '를 붙이므로, 불릿째로 걷어내야 산문만 남은 섹션이 된다.
	const source = shareSource().replace('- 구현 완료 조건과 구체 요구사항', prose);
	assert.ok(source.includes(`\n${prose}\n`), '픽스처에서 불릿이 제거되어야 한다');
	assert.throws(() => buildPrompt({ source }), /미정입니다/);
});
