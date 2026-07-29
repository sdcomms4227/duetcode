const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanRepo, scanFile, ALLOWED_LITERALS } = require('../check-secret-literals');

let counter = 0;
function tmpFile(name, content) {
	const dir = path.join(os.tmpdir(), `duet-secret-lint-${process.pid}-${counter++}`);
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, name);
	fs.writeFileSync(file, content);
	return { dir, file };
}

test('저장소에 자격증명 형태의 리터럴이 없다', () => {
	// 이 규칙이 문서에만 있던 시절, 리터럴 픽스처가 커밋에 들어가 push protection에 막혔고
	// 이력 전체를 filter-branch로 재작성해야 했다(docs/release-checklist.md §2).
	const findings = scanRepo();
	const detail = findings.map((f) => `${f.file}:${f.line} (${f.kind})`).join('\n  ');
	assert.deepEqual(findings, [], `리터럴 발견 — 런타임 조립으로 바꾸세요:\n  ${detail}`);
});

test('린트가 실제로 리터럴을 잡는다(자기검증)', () => {
	// 통과가 "검사가 동작한다"가 아니라 "패턴이 하나도 안 맞는다"일 수 있다. 종류별로 실제 탐지를 확인한다.
	const cases = [
		['aws.js', "const k = 'ASIA" + 'B'.repeat(16) + "';", 'AWS access key ID'],
		['gcp.md', '키: AIza' + 'A'.repeat(35), 'Google API key'],
		['slack.txt', 'xoxb-' + '1'.repeat(10) + '-' + '2'.repeat(10) + '-' + 'x'.repeat(24), 'Slack token'],
		['openai.js', "'sk-" + 'a'.repeat(40) + "'", 'OpenAI-style secret key'],
		['gh.yml', 'token: ghp_' + 'A'.repeat(36), 'GitHub token'],
		['jwt.json', '{"t":"' + ['eyJ', 'hbGciOiJIUzI1NiJ9'].join('') + '.' + ['eyJ', 'zdWIiOiJ4In0'].join('') + '.sig_value_1234"}', 'JWT']
	];
	for (const [name, content, kind] of cases) {
		const { dir, file } = tmpFile(name, content);
		try {
			const findings = scanFile(file);
			assert.equal(findings.length, 1, `${kind}를 잡지 못했다: ${name}`);
			assert.equal(findings[0].kind, kind);
			assert.equal(findings[0].line, 1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	}
});

test('런타임 조립 픽스처는 잡지 않는다', () => {
	// 규칙이 권장하는 형태가 오탐이면 규칙을 지킬 수 없다.
	const { dir, file } = tmpFile('ok.js', [
		"const a = 'ASIA' + 'B'.repeat(16);",
		"const b = 'AIza' + 'A'.repeat(35);",
		"const c = 'sk-' + 'a'.repeat(40);"
	].join('\n'));
	try {
		assert.deepEqual(scanFile(file), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('허용 목록의 값은 통과하고, 목록은 근거 있는 값만 담는다', () => {
	const { dir, file } = tmpFile('allowed.js', "const k = 'AKIAIOSFODNN7EXAMPLE';");
	try {
		assert.deepEqual(scanFile(file), [], '공식 예시 키는 push protection에 막히지 않으므로 허용한다');
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
	// 허용 목록이 커지면 린트가 무력해진다. 늘릴 때는 "GitHub이 막지 않는다"는 근거가 있어야 한다.
	assert.deepEqual([...ALLOWED_LITERALS], ['AKIAIOSFODNN7EXAMPLE']);
});

test('린트 자신의 패턴 정의는 검사 대상이 아니다', () => {
	// 정규식은 자격증명이 아니다. 자기 자신을 잡으면 항상 실패한다.
	assert.deepEqual(scanFile(path.resolve(__dirname, '..', 'check-secret-literals.js')), []);
});
