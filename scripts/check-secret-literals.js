#!/usr/bin/env node
'use strict';
// 자격증명 형태의 **리터럴**이 저장소에 들어오는 것을 막는다.
//
// 왜 필요한가: redaction 테스트는 성격상 "진짜처럼 생긴" 값을 픽스처로 써야 하는데, GitHub push
// protection은 소스든 문서든 형식만 보고 막는다. 실제로 최초 커밋에 리터럴 픽스처가 들어가 push가
// 막혔고, 새 커밋으로 고쳐도 소용이 없어 `git filter-branch`로 이력 전체를 재작성해야 했다
// (docs/release-checklist.md §2). 아직 push 전이라 비용이 없었을 뿐이다.
//
// 그래서 규칙이 생겼다 — 픽스처는 **런타임 조립**으로 쓴다(`'ASIA' + 'B'.repeat(16)`).
// 그 규칙이 지금까지 문서에만 있었고, 지키는지는 사람이 기억해야 했다. 이 파일이 그것을 강제한다.
//
// 이 린트는 보안 경계가 아니다. 형식만 보므로 실제 비밀을 다 잡지 못하고, 잡을 의도도 없다.
// 목적은 하나다: **다음 push가 이력 재작성으로 이어지지 않게 한다.**

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.duet', '.github/workflows/.cache']);
// 텍스트만 본다. 바이너리는 형식 검사 대상이 아니다.
const SCAN_EXTENSIONS = new Set(['.js', '.json', '.md', '.txt', '.yml', '.yaml', '.mjs', '.cjs']);

// GitHub push protection이 실제로 막는 형태들. 여기 없는 형태를 새로 겪으면 추가한다.
const PATTERNS = [
  { name: 'AWS access key ID', regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'Slack token', regex: /\bxox[abprs]-[0-9A-Za-z-]{20,}\b/g },
  { name: 'OpenAI-style secret key', regex: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: 'JWT', regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g }
];

// GitHub이 **공식 예시로 인지해 막지 않는** 값들. 이력 재작성을 유발하지 않으므로 리터럴을 허용한다.
// 새 값을 여기 추가하려면 "GitHub이 이 값을 막지 않는다"는 근거가 있어야 한다. 근거가 없으면
// 허용하지 말고 런타임 조립으로 바꾼다 — 그쪽이 언제나 안전한 선택지다.
const ALLOWED_LITERALS = new Set([
  'AKIAIOSFODNN7EXAMPLE' // AWS 공식 문서의 예시 키
]);

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (SCAN_EXTENSIONS.has(path.extname(entry.name))) out.push(full);
  }
  return out;
}

// 이 파일 자신의 패턴 정의는 검사 대상이 아니다(정규식이지 자격증명이 아니다).
function scanFile(file) {
  if (path.resolve(file) === path.resolve(__filename)) return [];
  const content = fs.readFileSync(file, 'utf8');
  const findings = [];
  for (const { name, regex } of PATTERNS) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      if (ALLOWED_LITERALS.has(match[0])) continue;
      const line = content.slice(0, match.index).split('\n').length;
      findings.push({ file: path.relative(REPO_ROOT, file).split(path.sep).join('/'), line, kind: name });
    }
  }
  return findings;
}

function scanRepo(root = REPO_ROOT) {
  return walk(root, []).flatMap(scanFile);
}

if (require.main === module) {
  const findings = scanRepo();
  if (!findings.length) {
    console.log('secret-literals: 자격증명 형태의 리터럴 없음');
  } else {
    console.error('secret-literals: 자격증명 형태의 **리터럴**이 발견되었습니다.\n');
    for (const f of findings) console.error(`  ${f.file}:${f.line} — ${f.kind}`);
    console.error('\n픽스처는 런타임 조립으로 쓰세요 — 예: `\'ASIA\' + \'B\'.repeat(16)`.');
    console.error('리터럴로 두면 push protection에 막히고, 이미 커밋했다면 이력 재작성이 필요해집니다.');
    process.exitCode = 1;
  }
}

module.exports = { scanRepo, scanFile, PATTERNS, ALLOWED_LITERALS };
