#!/usr/bin/env node
// 이 디렉터리의 *.test.js만 골라 node --test에 파일 목록으로 넘긴다.
//
// package.json에 축약형을 두면 셸·Node 버전에 따라 동작이 갈리므로 쓰지 않는다(실측):
//   - `node --test .../test/*.test.js` — glob 확장을 셸에 맡긴다. Windows의 npm은 스크립트를
//     cmd.exe로 돌려 확장하지 않으므로 리터럴이 Node에 그대로 간다. Node 자체 glob은 21+라
//     18·20은 "Could not find"로 exit 1, 22는 통과한다. POSIX 셸은 확장하므로 또 다르다.
//   - `node --test <dir>` — 18·20은 디렉터리를 재귀 실행하지만 22는 그 경로를 모듈로 로드하려다
//     MODULE_NOT_FOUND로 죽는다.
//   - 파일을 나열하면 대상 저장소의 package.json에 목록이 굳는다. mergePackageJson은 임의의 기존
//     스크립트를 덮어쓰지 않으므로, 엔진에 테스트가 추가돼도 그 저장소는 영영 실행하지 않는다.
// 파일을 직접 열거하면 위 분기가 전부 사라진다. 대상이 0개면 성공이 아니라 실패로 끝낸다.
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
// NODE_TEST_CONTEXT를 물려주지 않는다: 이 러너가 test runner 안에서 실행되면 그 변수가 상속되어
// 자식이 child 모드로 돌고, 테스트가 실패해도 exit 0을 반환한다(실측). 실패는 언제나 전파되어야 한다.
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit', env });
if (result.error) {
  console.error(`테스트 실행에 실패했습니다: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
