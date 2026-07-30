const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (...p) => JSON.parse(fs.readFileSync(path.join(ROOT, ...p), 'utf8'));

// 버전 단일 소스는 package.json이다. plugin.json은 Claude Code 마켓플레이스가 읽고
// package.json은 npm/github: 설치가 읽으므로, 둘이 갈라지면 "설치된 엔진이 몇 버전인가"를
// 두 답이 서로 다르게 말하게 된다. 릴리스 스크립트 대신 이 테스트로 고정한다.
test('plugin.json 버전은 package.json과 일치한다', () => {
	const pkg = read('package.json');
	const plugin = read('.claude-plugin', 'plugin.json');
	assert.equal(plugin.version, pkg.version,
		`버전 불일치: package.json=${pkg.version}, plugin.json=${plugin.version}`);
});

test('bin이 가리키는 실행 파일이 존재하고 shebang을 갖는다', () => {
	const pkg = read('package.json');
	for (const [name, relPath] of Object.entries(pkg.bin)) {
		const file = path.join(ROOT, relPath);
		assert.ok(fs.existsSync(file), `bin.${name} 대상이 없다: ${relPath}`);
		const head = fs.readFileSync(file, 'utf8').slice(0, 32);
		assert.match(head, /^#!\/usr\/bin\/env node/, `bin.${name}에 shebang이 없다: ${relPath}`);
	}
});

test('files 목록이 배포에 필요한 경로를 모두 담는다', () => {
	const pkg = read('package.json');
	for (const entry of ['engine', 'templates', 'scripts/install.js']) {
		assert.ok(pkg.files.includes(entry), `files에 ${entry}가 없으면 배포본에서 빠진다`);
	}
	for (const entry of pkg.files) {
		assert.ok(fs.existsSync(path.join(ROOT, entry)), `files 항목이 실제로 없다: ${entry}`);
	}
});

test('부트스트랩이 읽는 원본이 모두 존재하고 files에 포함된다', () => {
	// 회귀: v0.1.0은 files에 docs가 없어 배포본에 pipeline-design/workflow-example이 빠졌고,
	// install.js가 존재 검사로 조용히 건너뛰어 문서 2개가 누락된 채 "완료"로 끝났다.
	// 실설치 스모크 테스트로만 드러났던 결함이라 여기서 고정한다.
	const { PACKAGE_SOURCES } = require(path.join(ROOT, 'scripts', 'install.js'));
	const files = read('package.json').files;
	for (const source of PACKAGE_SOURCES) {
		assert.ok(fs.existsSync(path.join(ROOT, source)), `부트스트랩 원본이 없다: ${source}`);
		const covered = files.some((entry) => source === entry || source.startsWith(entry.replace(/\/$/, '') + '/'));
		assert.ok(covered, `${source}가 files에 포함되지 않아 배포본에서 빠진다`);
	}
});

test('런타임이 안내하는 샘플 설정도 배포본에 포함된다', () => {
	// `task verify`는 설정이 없을 때 "이 파일을 복사하라"며 패키지 안의 경로를 계산해 알려준다.
	// 그 원본은 부트스트랩이 읽지 않으므로 PACKAGE_SOURCES에 없고, 지금은 files의 'templates'
	// 통짜 항목 덕에 우연히 배포되고 있을 뿐이다 — files를 개별 항목으로 좁히는 순간, 안내는
	// 배포본에 없는 경로를 가리키게 된다(v0.1.0의 docs 누락과 같은 형태다).
	const sample = 'templates/verify.example.json';
	const source = fs.readFileSync(path.join(ROOT, 'engine', 'task', 'verify.js'), 'utf8');
	assert.match(source, /'verify\.example\.json'/, 'verify가 안내하는 파일명이 바뀌면 이 테스트도 함께 고쳐야 한다');
	assert.ok(fs.existsSync(path.join(ROOT, sample)), `안내 대상 원본이 없다: ${sample}`);
	const files = read('package.json').files;
	const covered = files.some((entry) => sample === entry || sample.startsWith(entry.replace(/\/$/, '') + '/'));
	assert.ok(covered, `${sample}이 files에 포함되지 않아 배포본에서 빠진다`);
});

test('대상 저장소용 스니펫이 참조하는 실행 파일은 bin에 선언되어 있다', () => {
	const pkg = read('package.json');
	const snippet = read('templates', 'package-json-snippet.json');
	for (const [name, command] of Object.entries(snippet.scripts)) {
		const executable = command.split(/\s+/)[0];
		assert.ok(pkg.bin[executable], `스니펫 scripts.${name}이 선언되지 않은 실행 파일을 부른다: ${executable}`);
	}
	assert.ok(snippet.devDependencies.duetcode, '스니펫은 duetcode를 devDependency로 걸어야 한다');
});
