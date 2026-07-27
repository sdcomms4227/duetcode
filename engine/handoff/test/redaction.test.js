const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactText, StreamRedactor, redactJsonl, redactToFile, sanitizeFile } = require('../lib');

test('JWT, AWS, GCP, Slack, basic auth, PEM credential을 가린다', () => {
	const credentials = [
		'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_12345',
		'AKIAIOSFODNN7EXAMPLE',
		'ASIA' + 'B'.repeat(16),
		'AIza' + 'A'.repeat(35),
		'xoxb-' + '1'.repeat(10) + '-' + '2'.repeat(10) + '-' + 'x'.repeat(24)
	];
	const pem = [
		'-----BEGIN PRIVATE KEY-----',
		'ZmFrZS1wcml2YXRlLWtleS1tYXRlcmlhbA==',
		'-----END PRIVATE KEY-----'
	].join('\n');
	const source = [
		...credentials,
		'{"authorization":"Basic dXNlcjpwYXNzd29yZA=="}',
		'https://alice:s3cret@example.com/private',
		pem
	].join('\n');
	const redacted = redactText(source, {});

	for (const credential of credentials) assert.equal(redacted.includes(credential), false);
	assert.equal(redacted.includes('dXNlcjpwYXNzd29yZA=='), false);
	assert.equal(redacted.includes('alice:s3cret'), false);
	assert.equal(redacted.includes('ZmFrZS1wcml2YXRlLWtleS1tYXRlcmlhbA=='), false);
	assert.match(redacted, /\[REDACTED\]/);
});

test('멀티라인 환경변수는 줄바꿈 표현이 달라도 가린다', () => {
	const secret = 'alpha-secret\r\nbeta-secret';
	const redacted = redactText([
		'actual:',
		'alpha-secret\nbeta-secret',
		'escaped: alpha-secret\\nbeta-secret'
	].join('\n'), { MULTILINE_SECRET: secret });

	assert.equal(redacted.includes('alpha-secret\nbeta-secret'), false);
	assert.equal(redacted.includes('alpha-secret\\nbeta-secret'), false);
});

test('StreamRedactor는 chunk 경계에서 분할된 토큰도 마스킹한다', () => {
	// 토큰이 push 경계(AKIAIOSF|ODNN7EXAMPLE)에서 갈려도, flush가 완전한 문맥으로 redact하므로 원문이 복원되지 않는다.
	const out = [];
	const r = new StreamRedactor((t) => out.push(t), {});
	r.push('log line one\nAKIAIOSF');
	r.push('ODNN7EXAMPLE more\n');
	r.flush();
	const joined = out.join('');
	assert.equal(joined.includes('AKIAIOSFODNN7EXAMPLE'), false, '분할 토큰이 복원되면 안 된다');
	assert.match(joined, /\[REDACTED\]/);
});

test('StreamRedactor는 상한 초과 시 fail-closed로 latch되어 이후 push/flush도 거부한다', () => {
	const out = [];
	const r = new StreamRedactor((t) => out.push(t), {}, 32); // 작은 상한
	assert.throws(() => r.push('x'.repeat(40)), /상한/);
	assert.throws(() => r.push('more'), /fail-closed/, 'latch 후 push는 거부되어야 한다');
	assert.throws(() => r.flush(), /fail-closed/, 'latch 후 flush도 거부되어야 한다');
	assert.equal(out.length, 0, '상한 초과 시 아무것도 방출하지 않아야 한다');
});

test('redactJsonl은 JSON 직렬화된 원문(escaped quote 포함)을 필드 단위로 마스킹한다', () => {
	const line = JSON.stringify({ type: 'item.completed', item: { text: 'password="EVENT_SECRET_9f21_tail with space"' } });
	const out = redactJsonl(line, {});
	assert.equal(out.includes('EVENT_SECRET_9f21_tail'), false, 'JSONL 직렬화 경로에서 누출되면 안 된다');
	assert.doesNotThrow(() => JSON.parse(out), '재직렬화 결과는 유효한 JSON이어야 한다');
});

test('redactJsonl은 structured sensitive field(값만 있어도 key 기준)를 통째 마스킹한다', () => {
	for (const line of [
		JSON.stringify({ client_secret: 'STRUCTURED_SECRET_A' }),
		JSON.stringify({ outer: { api_key: 'STRUCTURED_SECRET_B' } }),
		JSON.stringify({ password: 'STRUCTURED_SECRET_C' })
	]) {
		assert.doesNotMatch(redactJsonl(line, {}), /STRUCTURED_SECRET_[ABC]/, line);
	}
});

test('URL userinfo는 길이와 무관하게(257자+) 마스킹한다', () => {
	const pw = 'p'.repeat(300);
	assert.equal(redactText('db=postgres://user:' + pw + '@host/x', {}).includes(pw), false);
});

test('민감 key는 세그먼트 정확 매칭 — author/authority 오탐 없이 cookie/passphrase/set-cookie를 가린다', () => {
	for (const [key, val] of [['cookie', 'SESSION_COOKIE_V'], ['set-cookie', 'SC_VAL'], ['passphrase', 'PP_VAL'], ['client_secret', 'CS_VAL'], ['apiKey', 'AK_VAL']]) {
		assert.equal(redactJsonl(JSON.stringify({ [key]: val }), {}).includes(val), false, key);
	}
	for (const key of ['author', 'authority']) {
		assert.doesNotMatch(redactJsonl(JSON.stringify({ [key]: 'PLAINVALUE' }), {}), /REDACTED/, key);
	}
});

test('redactJsonl 폴백(invalid JSON)에서도 quoted sensitive key의 미종결 값을 EOL까지 마스킹한다', () => {
	const out = redactJsonl('{"client_secret":"unterminated secret value', {});
	assert.equal(out.includes('unterminated secret value'), false);
});

test('미종결 인용값·공백 포함 unquoted sensitive 값은 줄 끝까지 마스킹한다', () => {
	assert.equal(redactText('password="very secret unterminated', {}).includes('secret'), false);
	assert.equal(redactText('password: very secret phrase here', {}).includes('secret'), false);
});

test('contextual secret 할당과 짧은 payload JWT도 가린다', () => {
	const awsSecret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
	const shortJwt = 'eyJhbGciOiJIUzI1NiJ9.eyJ9.ab';
	const redacted = redactText(['aws_secret_access_key=' + awsSecret, 'token: ' + shortJwt].join('\n'), {});
	assert.equal(redacted.includes(awsSecret), false, 'contextual AWS secret 누출');
	assert.equal(redacted.includes(shortJwt), false, '짧은 payload JWT 누출');
});

test('JSON client_secret·짧은 Basic·콜론 포함 URL 비밀번호를 가린다', () => {
	const jsonSecret = 'clientsecretvalue123';
	const source = [
		'{"client_secret":"' + jsonSecret + '","x":1}',
		'Authorization: Basic YWJj',                 // base64("abc") — 짧은 값
		'https://user:pa:ss:word@example.com/x'      // 비밀번호에 콜론 포함
	].join('\n');
	const redacted = redactText(source, {});
	assert.equal(redacted.includes(jsonSecret), false, 'JSON client_secret 누출');
	assert.equal(redacted.includes('YWJj'), false, '짧은 Basic 값 누출');
	assert.equal(redacted.includes('pa:ss:word'), false, '콜론 포함 URL 비밀번호 누출');
});

test('quoted 자격증명(공백·escaped quote·single-quote)도 부분 누출 없이 가린다', () => {
	const bs = String.fromCharCode(92); // 백슬래시
	const cases = [
		['password="abcd efgh ijkl"', 'efgh ijkl'],                        // 공백 포함 → 예전엔 뒷부분 누출
		['{"client_secret":"abc' + bs + '"defsecret"}', 'defsecret'],      // escaped quote → 예전엔 뒷부분 누출
		["{'client_secret':'sqsecretval'}", 'sqsecretval']                 // single-quoted JSON
	];
	for (const [input, secret] of cases) {
		assert.equal(redactText(input, {}).includes(secret), false, input);
	}
});

test('StreamRedactor는 margin을 넘는 멀티라인 시크릿도 경계에서 복원되지 않게 가린다', () => {
	// ~18KB 멀티라인 env 시크릿을 작은 chunk로 분할 push해도 flush가 완전한 문맥으로 redact한다(경계 누출 방지).
	const bigSecret = 'BIGSECRET-' + 'x\n'.repeat(9000) + '-END';
	const chunks = [];
	const r = new StreamRedactor((t) => chunks.push(t), { HUGE_SECRET_TOKEN: bigSecret });
	const blob = 'preamble\n' + bigSecret + '\npostamble\n';
	for (let i = 0; i < blob.length; i += 700) r.push(blob.slice(i, i + 700));
	r.flush();
	const joined = chunks.join('');
	assert.equal(joined.includes(bigSecret), false, 'margin 초과 멀티라인 시크릿이 복원되면 안 된다');
	assert.match(joined, /\[REDACTED\]/);
});

test('redactToFile은 raw를 정화해 최종본을 쓰고 원문 raw를 항상 제거한다', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redactfile-'));
	const raw = path.join(dir, 'last-message.raw.txt');
	const final = path.join(dir, 'last-message.txt');
	try {
		fs.writeFileSync(raw, 'answer: AKIAIOSFODNN7EXAMPLE ok\n');
		assert.equal(redactToFile(raw, final, {}), true);
		assert.equal(fs.existsSync(raw), false, 'raw 원문은 제거되어야 한다');
		const content = fs.readFileSync(final, 'utf8');
		assert.equal(content.includes('AKIAIOSFODNN7EXAMPLE'), false);
		assert.match(content, /\[REDACTED\]/);
		assert.equal(redactToFile(path.join(dir, 'missing.raw'), final, {}), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test('sanitizeFile은 원문을 마스킹하고 파일을 원자적으로 교체한다', () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanitize-'));
	const file = path.join(dir, 'last-message.txt');
	try {
		fs.writeFileSync(file, 'result: AKIAIOSFODNN7EXAMPLE done\n');
		assert.equal(sanitizeFile(file, {}), true);
		const content = fs.readFileSync(file, 'utf8');
		assert.equal(content.includes('AKIAIOSFODNN7EXAMPLE'), false);
		assert.match(content, /\[REDACTED\]/);
		assert.equal(sanitizeFile(path.join(dir, 'missing.txt'), {}), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
