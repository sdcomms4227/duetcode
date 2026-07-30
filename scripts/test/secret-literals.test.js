const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanRepo, scanFile, ALLOWED_LITERALS, SKIP_DIRS } = require('../check-secret-literals');

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

test('점으로 시작하는 디렉터리도 스캔한다', () => {
	// 예전에는 .github만 예외로 두고 점 디렉터리를 전부 건너뛰어, **배포 대상인** .claude-plugin/이
	// 검사되지 않았다. 규칙은 옳은데 walk가 파일에 도달하지 못하는 형태였고, 그건 조용히 통과하는 검사다.
	const probe = path.resolve(__dirname, '..', '..', '.claude-plugin', '_secret-lint-probe.json');
	fs.writeFileSync(probe, JSON.stringify({ key: 'AIza' + 'A'.repeat(35) }));
	try {
		const found = scanRepo().filter((f) => f.file.endsWith('_secret-lint-probe.json'));
		assert.equal(found.length, 1, '.claude-plugin/ 아래를 스캔해야 한다');
		assert.equal(found[0].kind, 'Google API key');
	} finally {
		fs.rmSync(probe, { force: true });
	}
});

test('제외 목록의 디렉터리는 실제로 스캔하지 않는다', () => {
	// 남의 코드(node_modules)와 git 객체 저장소는 형식 검사 대상이 아니다. 제외가 이름 검사만이 아니라
	// walk에서 실제로 동작하는지 본다 — 임시 트리를 만들어 위반을 심고, 찾지 못해야 통과다.
	const root = fs.mkdtempSync(path.join(os.tmpdir(), `duet-skip-${process.pid}-`));
	try {
		const violation = JSON.stringify({ key: 'AIza' + 'A'.repeat(35) });
		for (const dir of [...SKIP_DIRS]) {
			fs.mkdirSync(path.join(root, dir, 'nested'), { recursive: true });
			fs.writeFileSync(path.join(root, dir, 'nested', 'leak.json'), violation);
		}
		assert.deepEqual(scanRepo(root), [], '제외 디렉터리 안의 위반은 보고하지 않는다');

		// 같은 파일을 제외 대상 밖에 두면 반드시 잡혀야 한다(검사가 살아 있음을 확인한다).
		fs.writeFileSync(path.join(root, 'leak.json'), violation);
		assert.equal(scanRepo(root).length, 1, '제외 대상 밖이면 잡아야 한다');
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
	assert.ok(!SKIP_DIRS.has('.claude-plugin'), '배포 대상 디렉터리는 제외하지 않는다');
});

test('린트 자신의 패턴 정의는 검사 대상이 아니다', () => {
	// 정규식은 자격증명이 아니다. 자기 자신을 잡으면 항상 실패한다.
	assert.deepEqual(scanFile(path.resolve(__dirname, '..', 'check-secret-literals.js')), []);
});
