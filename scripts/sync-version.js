#!/usr/bin/env node
// package.json의 version을 단일 소스로 삼아, 설치 대상이 실제로 해석하는 버전 참조를 맞춘다.
//
// 왜 스크립트인가: v0.1.2를 릴리스한 뒤에도 README·설치 스킬·설치 스니펫이 #v0.1.1을 가리킨 채
// 남아 있었다(실측). 스니펫은 대상 저장소의 devDependency로 그대로 써지므로, 드리프트가
// "안내만 옛날"이 아니라 "설치되는 엔진이 옛날"이 된다.
//
// 동기화 대상은 아래 TARGETS로 한정한다. release-checklist.md·public-release-readiness.md처럼
// 과거 경위를 서술하는 문서의 버전은 일부러 건드리지 않는다 — 거기 적힌 "v0.1.0 → v0.1.1에서
// 무엇이 깨졌나"는 기록이지 현재 값이 아니고, 자동 치환하면 기록 자체가 거짓이 된다.
//
// 사용법:
//   node scripts/sync-version.js          # 파일을 고친다
//   node scripts/sync-version.js --check  # 고치지 않고, 드리프트가 있으면 exit 1
//
// `npm version --no-git-tag-version`의 version 라이프사이클에서 이 스크립트를 부른다.
// 커밋과 태그는 사람이 검토한 뒤 별도로 만든다.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

// 각 항목: 파일 안에서 찾아 바꿀 패턴과, 현재 버전으로부터 기대값을 만드는 함수.
// 패턴은 반드시 g 플래그를 갖고 버전 부분을 캡처해야 한다.
const TARGETS = [
  {
    file: 'README.md',
    pattern: /github:sdcomms4227\/duetcode#v(\d+\.\d+\.\d+)/g,
    expected: (version) => `github:sdcomms4227/duetcode#v${version}`,
  },
  {
    file: 'skills/pipeline-install/SKILL.md',
    pattern: /github:sdcomms4227\/duetcode#v(\d+\.\d+\.\d+)/g,
    expected: (version) => `github:sdcomms4227/duetcode#v${version}`,
  },
  {
    // 설치기가 대상 저장소의 package.json에 그대로 써 넣는 값이라 가장 영향이 크다.
    file: 'templates/package-json-snippet.json',
    pattern: /github:sdcomms4227\/duetcode#v(\d+\.\d+\.\d+)/g,
    expected: (version) => `github:sdcomms4227/duetcode#v${version}`,
  },
  {
    // 마켓플레이스가 읽는 값. package-meta.test.js가 일치를 단정하지만, 그건 어긋난 뒤에야
    // 알려준다. 여기서 맞춰 두면 릴리스 시점에 애초에 어긋나지 않는다.
    file: '.claude-plugin/plugin.json',
    pattern: /("version"\s*:\s*")(\d+\.\d+\.\d+)(")/g,
    expected: (version) => `$1${version}$3`,
    capture: 2,
  },
];

function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version || '')) {
    throw new Error(`package.json의 version을 읽을 수 없습니다: ${pkg.version}`);
  }
  return pkg.version;
}

// 대상 하나를 검사한다. { changed, next, stale: [발견된 옛 버전] }를 돌려준다.
function inspect(target, version) {
  const file = path.join(ROOT, target.file);
  if (!fs.existsSync(file)) {
    throw new Error(`동기화 대상이 없습니다: ${target.file}`);
  }
  const before = fs.readFileSync(file, 'utf8');
  const captureIndex = target.capture || 1;
  const stale = [];
  let matched = 0;
  const after = before.replace(target.pattern, (...args) => {
    matched += 1;
    const found = args[captureIndex];
    if (found !== version) stale.push(found);
    return target.expected(version).replace(/\$(\d)/g, (_, n) => args[Number(n)]);
  });
  if (!matched) {
    // 패턴이 하나도 안 걸리면 파일 구조가 바뀐 것이다. 조용히 통과시키면 동기화가
    // 동작하지 않는 채로 계속 "성공"한다 — v0.1.0의 문서 누락이 그렇게 게시까지 갔다.
    throw new Error(`${target.file}에서 버전 참조를 찾지 못했습니다. 패턴을 갱신하세요.`);
  }
  return { changed: after !== before, next: after, stale, file };
}

function main(argv) {
  const check = argv.includes('--check');
  const version = readVersion();
  const drifted = [];
  for (const target of TARGETS) {
    const result = inspect(target, version);
    if (!result.changed) continue;
    drifted.push(`${target.file} (${[...new Set(result.stale)].join(', ')} → ${version})`);
    if (!check) fs.writeFileSync(result.file, result.next);
  }
  if (!drifted.length) {
    console.log(`버전 참조가 package.json(${version})과 일치합니다.`);
    return 0;
  }
  if (check) {
    console.error(`버전 참조가 package.json(${version})과 어긋납니다:`);
    for (const line of drifted) console.error(`  - ${line}`);
    console.error('`npm run version:sync`로 맞추세요.');
    return 1;
  }
  console.log(`버전 참조를 ${version}으로 맞췄습니다:`);
  for (const line of drifted) console.log(`  - ${line}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(`버전 동기화에 실패했습니다: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { TARGETS, readVersion, inspect, main };
