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

// 대상 저장소 docs/에 설치되는 문서: [배포본 원본(패키지 루트 기준), 대상 파일명].
// **대상 파일명은 공개 계약이다.** 설치기는 사용자 파일을 지우지 않으므로, 이름을 바꾸면 기존 설치
// 대상에 구 파일이 남은 채 신 파일이 추가되어 둘이 공존한다(cc-symphony → duetcode 개명 때 실제로
// 발생했다). scripts/test/install.test.js가 이 목록을 고정하고, 이름을 바꾸면 LEGACY_DOCS에
// 옛 이름을 추가해 잔재가 보고되도록 해야 한다.
const INSTALLED_DOCS = [
  ['templates/collaboration-protocol.md', 'duetcode-collaboration-protocol.md'],
  ['docs/pipeline-design.md', 'duetcode-pipeline-design.md'],
  ['docs/pipeline-workflow-example.md', 'duetcode-pipeline-workflow-example.md']
];

// 개명 이전에 설치되던 docs/ 파일명. 지우지 않고 알리기만 한다 —
// OBSOLETE_SCRIPTS·tools/ 잔재와 같은 정책이다(남의 저장소 파일을 말없이 지우지 않는다).
const LEGACY_DOCS = [
  ['cc-symphony-collaboration-protocol.md', 'duetcode-collaboration-protocol.md'],
  ['cc-symphony-pipeline-design.md', 'duetcode-pipeline-design.md'],
  ['cc-symphony-pipeline-workflow-example.md', 'duetcode-pipeline-workflow-example.md']
];

// 부트스트랩이 배포본에서 읽는 원본들(패키지 루트 기준). package.json의 files가 이 경로를
// 전부 포함해야 하며, scripts/test/package-meta.test.js가 그것을 강제한다.
// v0.1.0에서 files에 docs가 빠져 문서 2개가 배포본에 없었고, 설치는 그대로 "완료"로 끝났다.
const PACKAGE_SOURCES = [
  'templates/TASK.template.md',
  'templates/task-lint.yml',
  'templates/gitignore-snippet.txt',
  'templates/package-json-snippet.json',
  ...INSTALLED_DOCS.map(([source]) => source)
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

// TASK.md의 branch를 정한다. 부트스트랩은 **커밋이 하나도 없는 저장소**(`git init` 직후)에서 도는 것이
// 정상 경로인데, 거기서 `rev-parse --abbrev-ref HEAD`는 실패한다 — HEAD가 아직 아무 커밋도 가리키지 않기
// 때문이다. 그러면 두 가지가 어긋났다(둘 다 실측): ① 기본 브랜치가 main이 아닌 저장소(`git init -b develop`)에
// 'main'이 적혀, 단일 소스가 사실과 다른 브랜치를 말한다. ② execFileSync는 기본적으로 자식 stderr를
// 부모로 흘려보내므로, 성공한 부트스트랩 출력 한가운데에 git의 fatal 메시지가 찍힌다.
// `symbolic-ref --short HEAD`는 커밋 이전에도 답하므로 이것을 먼저 쓰고, detached HEAD(심볼릭이 아니라
// 실패한다)에서만 기존 명령으로 내려간다. stderr는 삼킨다 — 두 실패 모두 폴백으로 처리되는 정상 경로다.
function gitBranch(cwd) {
  for (const args of [['symbolic-ref', '--short', 'HEAD'], ['rev-parse', '--abbrev-ref', 'HEAD']]) {
    try {
      const branch = execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      if (branch && branch !== 'HEAD') return branch;
    } catch { /* 다음 후보로 */ }
  }
  return 'main';
}

// 대상 저장소 파일은 임시 파일에 쓴 뒤 rename한다. 이 저장소는 TASK.md(save)와 핸드오프 상태(writeJson)를
// 이미 그렇게 다루는데, 정작 남의 저장소 package.json만 직접 덮어쓰고 있었다 — 쓰기 도중 죽으면
// 대상의 package.json이 반쯤 쓰인 채 남아 그 저장소의 npm 명령이 전부 막힌다.
function writeFileAtomic(destPath, content) {
  const temporary = `${destPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, destPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* 실패한 임시 파일 정리는 best-effort */ }
    throw error;
  }
}

// 디렉터리만 만든다. 이미 있으면 아무것도 하지 않는다(설치기는 "추가만" 하는 도구다).
function ensureDirectory(dirPath) {
  if (fs.existsSync(dirPath)) { did('skip(존재)', rel(dirPath) + '/'); return; }
  fs.mkdirSync(dirPath, { recursive: true });
  did('create', rel(dirPath) + '/');
}
function ensureFileFromTemplate(templatePath, destPath, transform) {
  if (fs.existsSync(destPath)) { did('skip(존재)', rel(destPath)); return; }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let content = fs.readFileSync(templatePath, 'utf8');
  if (transform) content = transform(content);
  writeFileAtomic(destPath, content);
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
  let added = false;
  for (const [k, v] of Object.entries(snippet.scripts)) {
    if (!handoff && k.startsWith('handoff')) continue;
    if (pkg.scripts[k] == null) { pkg.scripts[k] = v; did('add-script', k); added = true; }
    else if (pkg.scripts[k] === v) continue;
    else if ((LEGACY_SCRIPTS[k] || []).includes(pkg.scripts[k])) { pkg.scripts[k] = v; did('migrate-script', k); added = true; }
    else conflicts.push(`scripts.${k} (기존: ${pkg.scripts[k]})`);
  }
  for (const [k, v] of Object.entries(snippet.devDependencies)) {
    if (pkg.devDependencies[k] == null) { pkg.devDependencies[k] = v; did('add-dep', `${k}@${v}`); added = true; }
  }
  if (!pkg.engines) { pkg.engines = snippet.engines; added = true; }
  // 실제로 무언가 추가했을 때만 쓴다. 내용 비교가 아니라 "추가했는가"로 판정하는 이유는, 대상이 다른
  // 들여쓰기를 쓰고 있으면 내용이 같아도 직렬화 결과가 달라 매번 재포맷 diff가 나기 때문이다.
  // 설치기는 "추가만" 하는 도구이므로, 추가할 것이 없는 재실행은 파일을 건드리지 않아야 한다.
  if (existed && !added) did('skip(변경 없음)', 'package.json');
  else {
    writeFileAtomic(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    did(existed ? 'merge' : 'create', 'package.json');
  }
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
  writeFileAtomic(giPath, existing + sep + (existing ? '\n' : '') + additions.join('\n') + '\n');
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
  // preflight: 배포본 원본이 전부 있는지 먼저 확인한다. 예전에는 문서 존재 검사가 마지막 단계에 있어서,
  // files 누락 같은 배포 결함(v0.1.0에서 실제 발생)이 나면 package.json·TASK.md·CI·.gitignore가 이미
  // 쓰인 뒤에 실패해 대상이 어중간한 상태로 남았다. 순수한 존재 검사라 쓰기 전에 할 수 있다.
  const missing = PACKAGE_SOURCES.filter((source) => !fs.existsSync(path.join(PACKAGE_ROOT, source)));
  if (missing.length) {
    throw new Error(`배포본에 원본이 없습니다: ${missing.join(', ')} (package.json의 files 확인 필요). 대상 저장소는 건드리지 않았습니다.`);
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

  // 4.1 런타임 상태·로컬 설정이 들어갈 .duet/ — gitignore 대상이라 git에는 아무것도 나타나지 않지만,
  // 없으면 `task verify` 설정을 두려는 사용자가 mkdir부터 해야 한다(실설치 스모크에서 실제로 걸렸다).
  // 핸드오프는 .duet/state/를 스스로 만들고 verify는 읽기만 하므로, 만들어 주는 쪽이 일관적이다.
  ensureDirectory(path.join(TARGET_ROOT, '.duet'));

  // 5. 규약·설계·예시 문서
  // 원본 부재는 위 preflight가 이미 걸렀다(PACKAGE_SOURCES). 예전에는 여기서 존재 검사로 넘겨서,
  // package.json의 files에 docs가 빠진 배포본이 문서 2개를 말없이 누락한 채 "완료"로 끝났다
  // (v0.1.0에서 실제 발생). 검사를 없앤 것이 아니라 쓰기 이전으로 옮긴 것이다.
  for (const [source, name] of INSTALLED_DOCS) {
    ensureFileFromTemplate(path.join(PACKAGE_ROOT, source), path.join(TARGET_ROOT, 'docs', name));
  }
  // 개명 이전 파일명이 남아 있으면 신 파일과 공존한다. 지우지 않고 알린다.
  const staleDocs = LEGACY_DOCS.filter(([old]) => fs.existsSync(path.join(TARGET_ROOT, 'docs', old)));

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
  if (staleDocs.length) {
    console.log('\n주의 — 개명 이전 문서가 남아 있어 신·구 파일이 공존합니다:');
    for (const [old, current] of staleDocs) console.log(`  - docs/${old}  →  docs/${current}로 대체됨`);
    console.log('  내용을 확인한 뒤 구 파일을 직접 삭제하고, 참조하던 링크(CLAUDE.md/AGENTS.md 등)를 갱신하세요.');
    console.log('  설치기는 사용자 문서를 지우지 않습니다.');
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

module.exports = { parseArgs, LEGACY_SCRIPTS, OBSOLETE_SCRIPTS, PACKAGE_SOURCES, INSTALLED_DOCS, LEGACY_DOCS };
