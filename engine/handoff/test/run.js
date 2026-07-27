#!/usr/bin/env node
// 이 디렉터리의 *.test.js만 골라 node --test에 파일 목록으로 넘긴다.
// 근거는 tools/task/test/run.js의 주석과 같다(glob·디렉터리 축약형은 셸·Node 버전마다 동작이 갈린다).
// 두 엔진은 서로 독립적으로 복사·설치되므로(--no-handoff면 task만 설치된다) 러너를 공유하지 않는다.
// 대상이 0개면 성공이 아니라 실패로 끝낸다.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const files = fs.readdirSync(__dirname)
	.filter((name) => name.endsWith('.test.js'))
	.sort()
	.map((name) => path.join(__dirname, name));
if (!files.length) {
	console.error(`실행할 테스트 파일이 없습니다: ${__dirname}`);
	process.exit(1);
}
// NODE_TEST_CONTEXT를 물려주지 않는다: test runner 안에서 실행되면 자식이 child 모드로 돌아
// 테스트가 실패해도 exit 0을 반환한다(실측). 실패는 언제나 전파되어야 한다.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', env });
if (result.error) {
	console.error(`테스트 실행에 실패했습니다: ${result.error.message}`);
	process.exit(1);
}
process.exit(result.status ?? 1);
