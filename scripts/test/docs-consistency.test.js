const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..', '..');
const SKIP_DIRS = new Set(['.git', '.duet', 'node_modules']);
const PACKAGE_FILES = require(path.join(ROOT, 'package.json')).files;

function markdownFiles(dir = ROOT) {
	const files = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) files.push(...markdownFiles(full));
		else if (entry.isFile() && entry.name.endsWith('.md')) files.push(full);
	}
	return files;
}

function headingSlugs(source) {
	return new Set(
		[...source.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) =>
			match[1]
				.toLowerCase()
				.replace(/[`*_~]/g, '')
				.replace(/[^\p{L}\p{N} -]/gu, '')
				.trim()
				.replace(/\s+/g, '-')
		)
	);
}

function isPackaged(relativePath) {
	const normalized = relativePath.replaceAll('\\', '/');
	if (['LICENSE', 'README.md', 'package.json'].includes(normalized)) return true;
	return PACKAGE_FILES.some((entry) => normalized === entry || normalized.startsWith(`${entry}/`));
}

test('저장소 Markdown의 로컬 링크와 앵커가 실제 대상을 가리킨다', () => {
	for (const file of markdownFiles()) {
		const source = fs.readFileSync(file, 'utf8');
		for (const match of source.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
			const raw = match[1].replace(/^<|>$/g, '');
			if (path.relative(ROOT, file) === path.join('templates', 'collaboration-protocol.md') && raw === '../TASK.md') {
				continue; // 설치 후 대상 저장소의 docs/에서 루트 TASK.md를 가리킨다.
			}
			const [relativePath, fragment] = raw.split('#', 2);
			const target = path.resolve(path.dirname(file), relativePath);
			assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)}의 링크 대상이 없음: ${raw}`);
			if (!fragment) continue;
			const targetSource = fs.readFileSync(target, 'utf8');
			const explicit = targetSource.includes(`id="${fragment}"`) || targetSource.includes(`id='${fragment}'`);
			assert.ok(
				explicit || headingSlugs(targetSource).has(fragment.toLowerCase()),
				`${path.relative(ROOT, file)}의 링크 앵커가 없음: ${raw}`
			);
		}
	}
});

test('절 번호를 이름에 쓴 교차 문서 링크는 해당 fragment를 명시한다', () => {
	for (const file of markdownFiles()) {
		const source = fs.readFileSync(file, 'utf8');
		assert.doesNotMatch(
			source,
			/\[[^\]]*§\d+[^\]]*\]\([^#)]+\.md\)/,
			`${path.relative(ROOT, file)}에 문서 첫 화면만 여는 절 번호 링크가 있음`
		);
	}
});

test('공개 문서에 환경 종속 Windows 절대경로를 남기지 않는다', () => {
	for (const file of markdownFiles()) {
		const source = fs.readFileSync(file, 'utf8');
		assert.doesNotMatch(
			source,
			/`[A-Za-z]:\\[^`]+`/,
			`${path.relative(ROOT, file)}에 로컬 Windows 절대경로가 있음`
		);
	}
});

test('npm 배포 Markdown의 상대 링크 대상도 배포본에 포함된다', () => {
	for (const file of markdownFiles()) {
		const sourceRelative = path.relative(ROOT, file);
		if (!isPackaged(sourceRelative)) continue;
		const source = fs.readFileSync(file, 'utf8');
		for (const match of source.matchAll(/\]\((?!https?:|mailto:|#)([^)]+)\)/g)) {
			const raw = match[1].replace(/^<|>$/g, '');
			if (sourceRelative === path.join('templates', 'collaboration-protocol.md') && raw === '../TASK.md') {
				continue; // 설치 후 생성되는 대상 저장소 파일을 가리키는 템플릿 링크.
			}
			const [relativePath] = raw.split('#', 1);
			const targetRelative = path.relative(ROOT, path.resolve(path.dirname(file), relativePath));
			assert.ok(
				isPackaged(targetRelative),
				`${sourceRelative}의 상대 링크 대상이 npm 배포본에서 빠짐: ${raw}`
			);
		}
	}
});

test('배포 command와 skill의 YAML front matter가 파싱된다', () => {
	const files = [
		path.join(ROOT, 'commands', 'task.md'),
		path.join(ROOT, 'commands', 'handoff.md'),
		path.join(ROOT, 'skills', 'pipeline', 'SKILL.md'),
		path.join(ROOT, 'skills', 'pipeline-install', 'SKILL.md')
	];
	for (const file of files) {
		const source = fs.readFileSync(file, 'utf8');
		const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
		assert.ok(match, `${path.relative(ROOT, file)}에 YAML front matter가 없음`);
		assert.doesNotThrow(
			() => YAML.parse(match[1]),
			`${path.relative(ROOT, file)}의 YAML front matter를 파싱할 수 없음`
		);
	}
});

test('Markdown 코드 펜스가 같은 문자로 열리고 닫힌다', () => {
	for (const file of markdownFiles()) {
		const source = fs.readFileSync(file, 'utf8');
		const stack = [];
		for (const match of source.matchAll(/^\s*(`{3,}|~{3,})/gm)) {
			const marker = match[1][0];
			if (!stack.length) stack.push(marker);
			else {
				assert.equal(marker, stack.pop(), `${path.relative(ROOT, file)}의 코드 펜스 닫힘 문자가 다름`);
			}
		}
		assert.deepEqual(stack, [], `${path.relative(ROOT, file)}에 닫히지 않은 코드 펜스가 있음`);
	}
});

test('README의 대상 저장소용 선택 템플릿은 npm 패키지 경로를 안내한다', () => {
	const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
	assert.match(readme, /node_modules\/duetcode\/templates\/stop-hook-snippet\.json/);
	assert.doesNotMatch(readme, /merge `templates\/stop-hook-snippet\.json`/);
});
