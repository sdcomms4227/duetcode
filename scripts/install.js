#!/usr/bin/env node
/**
 * duetcode pipeline 설치기.
 *
 * 대상 저장소(기본: cwd)에 상태머신 엔진과 규약/템플릿을 멱등하게 배치한다.
 *   node scripts/install.js [--target <path>] [--force] [--no-handoff]
 *
 * - 기본은 "없으면 생성, 있으면 보존". 기존 사용자 파일을 덮어쓰지 않는다.
 * - --force: tools/task·tools/handoff 엔진을 최신본으로 덮어쓴다(로컬 엔진 수정은 사라짐).
 * - --no-handoff: Codex 핸드오프 없이 코어(task 상태머신 + lint + CI)만 설치.
 * Node 내장 모듈만 사용한다(yaml 설치 이전에 실행되므로).
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const ENGINE = path.join(PLUGIN_ROOT, 'engine');
const TEMPLATES = path.join(PLUGIN_ROOT, 'templates');
const DOCS = path.join(PLUGIN_ROOT, 'docs');

function parseArgs(argv) {
  const opts = { target: process.cwd(), force: false, handoff: true, engineOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--target') opts.target = path.resolve(argv[++i] || '.');
    else if (a === '--force') opts.force = true;
    else if (a === '--no-handoff') opts.handoff = false;
    else if (a === '--engine-only') opts.engineOnly = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error('알 수 없는 옵션: ' + a);
  }
  return opts;
}

const log = [];
function did(action, target) { log.push(`  [${action}] ${target}`); }

function gitBranch(cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8' }).trim() || 'main';
  } catch { return 'main'; }
}

function copyDir(src, dest, force) {
  if (fs.existsSync(dest) && !force) { did('skip(존재)', rel(dest)); return; }
  fs.cpSync(src, dest, { recursive: true, force: true });
  did(force && fs.existsSync(dest) ? 'update' : 'create', rel(dest));
}

let TARGET_ROOT;
function rel(p) { return path.relative(TARGET_ROOT, p).replaceAll('\\', '/'); }

function ensureFileFromTemplate(templatePath, destPath, transform) {
  if (fs.existsSync(destPath)) { did('skip(존재)', rel(destPath)); return; }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  let content = fs.readFileSync(templatePath, 'utf8');
  if (transform) content = transform(content);
  fs.writeFileSync(destPath, content, 'utf8');
  did('create', rel(destPath));
}

function mergePackageJson(target) {
  const pkgPath = path.join(target, 'package.json');
  const snippet = JSON.parse(fs.readFileSync(path.join(TEMPLATES, 'package-json-snippet.json'), 'utf8'));
  let pkg = {};
  let existed = false;
  if (fs.existsSync(pkgPath)) { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); existed = true; }
  pkg.scripts = pkg.scripts || {};
  pkg.devDependencies = pkg.devDependencies || {};
  const conflicts = [];
  for (const [k, v] of Object.entries(snippet.scripts)) {
    if (pkg.scripts[k] == null) { pkg.scripts[k] = v; did('add-script', k); }
    else if (pkg.scripts[k] !== v) conflicts.push(`scripts.${k} (기존: ${pkg.scripts[k]})`);
  }
  for (const [k, v] of Object.entries(snippet.devDependencies)) {
    if (pkg.devDependencies[k] == null) { pkg.devDependencies[k] = v; did('add-dep', `${k}@${v}`); }
  }
  if (!pkg.engines) pkg.engines = snippet.engines;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  did(existed ? 'merge' : 'create', 'package.json');
  return conflicts;
}

function appendGitignore(target) {
  const giPath = path.join(target, '.gitignore');
  const snippet = fs.readFileSync(path.join(TEMPLATES, 'gitignore-snippet.txt'), 'utf8');
  const existing = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  if (existing.includes('tools/handoff/state/')) { did('skip(존재)', '.gitignore'); return; }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(giPath, existing + sep + (existing ? '\n' : '') + snippet, 'utf8');
  did(existing ? 'append' : 'create', '.gitignore');
}

// CI 템플릿의 __HANDOFF_TEST__ 자리표시자를 handoff 설치 여부에 따라 치환한다.
// \r?\n? 로 CRLF 내성을 갖는다: core.autocrlf=true(Git-for-Windows 기본)로 clone하면 템플릿이 CRLF로
// 스머지될 수 있는데, 바른 LF만 매치하면 자리표시자가 생성된 워크플로에 그대로 남아 YAML이 깨진다.
function renderCiTemplate(content, handoff) {
  return content.replace(/__HANDOFF_TEST__\r?\n?/, handoff ? '      - run: npm run handoff:test\n' : '');
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('사용법: node scripts/install.js [--target <path>] [--force] [--no-handoff] [--engine-only]');
    return;
  }
  TARGET_ROOT = opts.target;
  if (!fs.existsSync(TARGET_ROOT)) throw new Error('대상 경로가 없습니다: ' + TARGET_ROOT);

  // preflight: full install은 TASK.md를 생성하므로, 최초 쓰기(엔진 복사·package.json 병합) 이전에
  // legacy SHARE.md split-brain을 검사한다. 실패해도 대상 저장소를 전혀 건드리지 않는다.
  // (engine-only는 TASK.md를 만들지 않아 분열 위험이 없으므로 검사하지 않는다.)
  const taskPath = path.join(TARGET_ROOT, 'TASK.md');
  if (!opts.engineOnly && !fs.existsSync(taskPath) && fs.existsSync(path.join(TARGET_ROOT, 'SHARE.md'))) {
    throw new Error('legacy SHARE.md가 있고 TASK.md가 없습니다. `git mv SHARE.md TASK.md`로 리네임한 뒤 다시 실행하세요(상태 분열 방지).');
  }

  const mode = opts.engineOnly ? ' [engine-only]' : (opts.handoff ? '' : ' (코어만, 핸드오프 제외)');
  console.log(`duetcode 설치 → ${TARGET_ROOT}${mode}${opts.force ? ' [force]' : ''}\n`);

  // 1. 엔진 배치
  copyDir(path.join(ENGINE, 'task'), path.join(TARGET_ROOT, 'tools', 'task'), opts.force);
  if (opts.handoff) copyDir(path.join(ENGINE, 'handoff'), path.join(TARGET_ROOT, 'tools', 'handoff'), opts.force);

  // --engine-only: 엔진(tools/)만 동기화하고 package.json·TASK.md·CI·.gitignore·docs는 건드리지 않는다.
  // 기존 설치 저장소의 엔진을 canonical 소스에서 갱신하는 용도. 갱신하려면 --force 동반 필요.
  if (opts.engineOnly) {
    console.log(log.join('\n'));
    console.log('\n엔진만 동기화했습니다(package.json·TASK.md·CI·docs 미변경).'
      + (opts.force ? '' : '\n주의: --force 없이는 기존 tools/가 있으면 skip됩니다. 갱신하려면 --engine-only --force.'));
    return;
  }

  // 2. package.json 병합
  const conflicts = mergePackageJson(TARGET_ROOT);

  // 3. TASK.md 생성(부재 시). legacy SHARE.md split-brain은 상단 preflight에서 이미 차단했다.
  const branch = gitBranch(TARGET_ROOT);
  ensureFileFromTemplate(
    path.join(TEMPLATES, 'TASK.template.md'),
    taskPath,
    (c) => c.replace('__BRANCH__', branch).replace('__UPDATED__', new Date().toISOString())
  );

  // 4. CI 워크플로 — 핸드오프 설치 여부에 따라 handoff:test 스텝을 조건부로 넣는다(--no-handoff와 양립).
  ensureFileFromTemplate(
    path.join(TEMPLATES, 'task-lint.yml'),
    path.join(TARGET_ROOT, '.github', 'workflows', 'task-lint.yml'),
    (c) => renderCiTemplate(c, opts.handoff)
  );

  // 5. .gitignore
  appendGitignore(TARGET_ROOT);

  // 6. 규약·설계·예시 문서
  ensureFileFromTemplate(path.join(TEMPLATES, 'collaboration-protocol.md'), path.join(TARGET_ROOT, 'docs', 'duetcode-collaboration-protocol.md'));
  if (fs.existsSync(path.join(DOCS, 'pipeline-design.md')))
    ensureFileFromTemplate(path.join(DOCS, 'pipeline-design.md'), path.join(TARGET_ROOT, 'docs', 'duetcode-pipeline-design.md'));
  if (fs.existsSync(path.join(DOCS, 'pipeline-workflow-example.md')))
    ensureFileFromTemplate(path.join(DOCS, 'pipeline-workflow-example.md'), path.join(TARGET_ROOT, 'docs', 'duetcode-pipeline-workflow-example.md'));

  // 요약
  console.log(log.join('\n'));
  console.log('\n완료. 다음 단계:');
  console.log('  1) npm install            # yaml devDependency 설치');
  console.log('  2) npm run task:lint      # TASK.md(IDLE) 검증 통과 확인');
  console.log('  3) npm run task:test      # 엔진 상태머신 테스트' + (opts.handoff ? ' / npm run handoff:test' : ''));
  console.log('  4) docs/duetcode-collaboration-protocol.md의 <...> 자리표시자를 프로젝트에 맞게 채우고,');
  console.log('     CLAUDE.md/AGENTS.md에서 이 문서를 협업 규약 단일 소스로 참조한다.');
  if (conflicts.length) {
    console.log('\n주의 — 기존 package.json 스크립트와 충돌(수동 확인 필요):');
    for (const c of conflicts) console.log('  - ' + c);
  }
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('install: ' + e.message); process.exitCode = 1; }
}

module.exports = { renderCiTemplate, parseArgs };
