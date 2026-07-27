#!/usr/bin/env node
/**
 * duetcode 부트스트랩.
 *
 * 대상 저장소에 상태 파일·규약 문서·CI·gitignore를 멱등하게 배치한다.
 *   npx duet-init [--target <path>] [--no-handoff]
 *
 * 엔진 자체는 더 이상 복사하지 않는다 — `duetcode` devDependency로 설치되고 `duet-task`·`duet-handoff`
 * 실행 파일로 호출된다. 그래서 이 스크립트는 "대상 저장소가 소유하는 것"만 만든다.
 * - 기본은 "없으면 생성, 있으면 보존". 기존 사용자 파일을 덮어쓰지 않는다.
 * - --no-handoff: Codex 핸드오프 없이 코어(task 상태머신 + lint + CI)만 구성.
 * Node 내장 모듈만 사용한다(대상의 npm install 이전에 실행될 수 있으므로).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const TEMPLATES = path.join(PACKAGE_ROOT, 'templates');
const DOCS = path.join(PACKAGE_ROOT, 'docs');

// 과거 버전이 설치했던 스크립트 값. 기존 값이 여기에 **정확히** 일치할 때만 현재 값으로 갱신한다.
// 사용자가 직접 손댄 스크립트는 갱신하지 않고 충돌로 보고만 한다(남의 저장소 설정을 말없이 바꾸지 않는다).
const LEGACY_SCRIPTS = {
  task: ['node tools/task/index.js'],
  'task:lint': ['node tools/task/index.js lint'],
  handoff: ['node tools/handoff/dispatch.js']
};

// 엔진이 대상 저장소에 복사되던 시절의 잔재. 이제 엔진 테스트는 상류(duetcode)에서 돌므로
// 대상에는 필요 없다. 사용자 파일을 말없이 지우지 않고 알리기만 한다.
const OBSOLETE_SCRIPTS = ['task:test', 'handoff:test'];

// 부트스트랩이 배포본에서 읽는 원본들(패키지 루트 기준). package.json의 files가 이 경로를
// 전부 포함해야 하며, scripts/test/package-meta.test.js가 그것을 강제한다.
// v0.1.0에서 files에 docs가 빠져 문서 2개가 배포본에 없었고, 설치는 그대로 "완료"로 끝났다.
const PACKAGE_SOURCES = [
  'templates/TASK.template.md',
  'templates/task-lint.yml',
  'templates/gitignore-snippet.txt',
  'templates/package-json-snippet.json',
  'templates/collaboration-protocol.md',
  'docs/pipeline-design.md',
  'docs/pipeline-workflow-example.md'
];

function parseArgs(argv) {
  const opts = { target: process.cwd(), handoff: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') opts.target = path.resolve(argv[++i] || '.');
    else if (a === '--no-handoff') opts.handoff = false;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error('알 수 없는 옵션: ' + a);
  }
  return opts;
}

const log = [];
function did(action, target) { log.push(`  [${action}] ${target}`); }

let TARGET_ROOT;
function rel(p) { return path.relative(TARGET_ROOT, p).replaceAll('\\', '/'); }

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || 'main';
  } catch { return 'main'; }
}

function ensureFileFromTemplate(templatePath, destPath, transform) {
  if (fs.existsSync(destPath)) { did('skip(존재)', rel(destPath)); return; }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let content = fs.readFileSync(templatePath, 'utf8');
  if (transform) content = transform(content);
  fs.writeFileSync(destPath, content, 'utf8');
  did('create', rel(destPath));
}

// handoff=false면 handoff 스크립트를 넣지 않는다. "추가하지 않음"이지 "제거"가 아니다 —
// 이미 설치된 핸드오프를 지우지는 않는다.
function mergePackageJson(target, handoff) {
  const pkgPath = path.join(target, 'package.json');
  const snippet = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'package-json-snippet.json'), 'utf8'));
  let pkg = {};
  let existed = false;
  if (fs.existsSync(pkgPath)) { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); existed = true; }
  pkg.scripts = pkg.scripts || {};
  pkg.devDependencies = pkg.devDependencies || {};
  const conflicts = [];
  for (const [k, v] of Object.entries(snippet.scripts)) {
    if (!handoff && k.startsWith('handoff')) continue;
    if (pkg.scripts[k] == null) { pkg.scripts[k] = v; did('add-script', k); }
    else if (pkg.scripts[k] === v) continue;
    else if ((LEGACY_SCRIPTS[k] || []).includes(pkg.scripts[k])) { pkg.scripts[k] = v; did('migrate-script', k); }
    else conflicts.push(`scripts.${k} (기존: ${pkg.scripts[k]})`);
  }
  for (const [k, v] of Object.entries(snippet.devDependencies)) {
    if (pkg.devDependencies[k] == null) { pkg.devDependencies[k] = v; did('add-dep', `${k}@${v}`); }
  }
  if (!pkg.engines) pkg.engines = snippet.engines;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  did(existed ? 'merge' : 'create', 'package.json');
  return { conflicts, obsolete: OBSOLETE_SCRIPTS.filter((name) => pkg.scripts[name] != null) };
}

// 항목 단위로 병합한다. 한 줄만 존재해도 전체를 건너뛰면 스니펫에 항목이 추가돼도
// 기존 설치 저장소에는 영영 전달되지 않는다.
// 패턴 바로 위의 연속 주석은 그 패턴과 함께 움직인다(이미 있는 항목의 주석을 중복 추가하지 않는다).
function appendGitignore(target) {
  const giPath = path.join(target, '.gitignore');
  const snippet = fs.readFileSync(path.join(TEMPLATES, 'gitignore-snippet.txt'), 'utf8');
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const have = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const additions = [];
  let comments = [];
  for (const line of snippet.split(/\r?\n/)) {
    const value = line.trim();
    if (!value) continue;
    if (value.startsWith('#')) { comments.push(line); continue; }
    if (!have.has(value)) { additions.push(...comments, line); have.add(value); }
    comments = [];
  }
  if (!additions.length) { did('skip(존재)', '.gitignore'); return; }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(giPath, existing + sep + (existing ? '\n' : '') + additions.join('\n') + '\n', 'utf8');
  did(existing ? 'append' : 'create', '.gitignore');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('사용법: npx duet-init [--target <path>] [--no-handoff]');
    return;
  }
  TARGET_ROOT = opts.target;
  if (!fs.existsSync(TARGET_ROOT)) throw new Error('대상 경로가 없습니다: ' + TARGET_ROOT);

  // preflight: TASK.md를 생성하므로, 최초 쓰기 이전에 legacy SHARE.md split-brain을 검사한다.
  // 실패해도 대상 저장소를 전혀 건드리지 않는다.
  const taskPath = path.join(TARGET_ROOT, 'TASK.md');
  if (!fs.existsSync(taskPath) && fs.existsSync(path.join(TARGET_ROOT, 'SHARE.md'))) {
    throw new Error('legacy SHARE.md가 있고 TASK.md가 없습니다. `git mv SHARE.md TASK.md`로 리네임한 뒤 다시 실행하세요(상태 분열 방지).');
  }

  console.log(`duetcode 부트스트랩 → ${TARGET_ROOT}${opts.handoff ? '' : ' (코어만, 핸드오프 제외)'}\n`);

  // 1. package.json — 엔진은 devDependency로 들어오고, 스크립트는 duet-* 실행 파일을 부른다.
  const { conflicts, obsolete } = mergePackageJson(TARGET_ROOT, opts.handoff);

  // 2. TASK.md 생성(부재 시)
  const branch = gitBranch(TARGET_ROOT);
  ensureFileFromTemplate(
    path.join(TEMPLATES, 'TASK.template.md'),
    taskPath,
    (c) => c.replace('__BRANCH__', branch).replace('__UPDATED__', new Date().toISOString())
  );

  // 3. CI 워크플로 — 엔진 테스트는 상류에서 돌므로 대상 CI는 task:lint만 검증한다.
  ensureFileFromTemplate(path.join(TEMPLATES, 'task-lint.yml'), path.join(TARGET_ROOT, '.github', 'workflows', 'task-lint.yml'));

  // 4. .gitignore
  appendGitignore(TARGET_ROOT);

  // 5. 규약·설계·예시 문서
  ensureFileFromTemplate(path.join(TEMPLATES, 'collaboration-protocol.md'), path.join(TARGET_ROOT, 'docs', 'duetcode-collaboration-protocol.md'));
  // 원본이 없으면 조용히 건너뛰지 않는다. 예전에는 존재 검사로 넘겨서, package.json의 files에
  // docs가 빠진 배포본이 문서 2개를 말없이 누락한 채 "완료"로 끝났다(v0.1.0에서 실제 발생).
  for (const [src, dest] of [['pipeline-design.md', 'duetcode-pipeline-design.md'], ['pipeline-workflow-example.md', 'duetcode-pipeline-workflow-example.md']]) {
    const source = path.join(DOCS, src);
    if (!fs.existsSync(source)) throw new Error(`배포본에 문서가 없습니다: docs/${src} (package.json files 확인 필요)`);
    ensureFileFromTemplate(source, path.join(TARGET_ROOT, 'docs', dest));
  }

  // 요약
  console.log(log.join('\n'));
  console.log('\n완료. 다음 단계:');
  console.log('  1) npm install            # duetcode 엔진 설치');
  console.log('  2) npm run task:lint      # TASK.md(IDLE) 검증 통과 확인');
  console.log('  3) docs/duetcode-collaboration-protocol.md의 <...> 자리표시자를 프로젝트에 맞게 채우고,');
  console.log('     CLAUDE.md/AGENTS.md에서 이 문서를 협업 규약 단일 소스로 참조한다.');

  if (conflicts.length) {
    console.log('\n주의 — 기존 package.json 스크립트와 충돌(수동 확인 필요):');
    for (const c of conflicts) console.log('  - ' + c);
  }
  if (obsolete.length) {
    console.log('\n주의 — 더 이상 필요 없는 스크립트가 남아 있습니다(엔진 테스트는 duetcode 저장소에서 돕니다):');
    for (const name of obsolete) console.log(`  - scripts.${name}`);
    console.log('  직접 삭제하세요. 설치기는 사용자 스크립트를 지우지 않습니다.');
  }
  if (fs.existsSync(path.join(TARGET_ROOT, 'tools', 'task'))) {
    console.log('\n주의 — 구버전 엔진 사본이 남아 있습니다: tools/');
    console.log('  엔진은 이제 node_modules의 duetcode에서 옵니다. `git rm -r tools/`로 정리하세요.');
    console.log('  (tools/handoff/state/에 진행 중인 핸드오프 상태가 있다면 .duet/state/로 옮긴 뒤 지우세요.)');
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('duet-init: ' + e.message); process.exitCode = 1; }
}

module.exports = { parseArgs, LEGACY_SCRIPTS, OBSOLETE_SCRIPTS, PACKAGE_SOURCES };
