const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { strayFrontMatter, parseSource } = require('../lib');
const { share, fixture, cli } = require('./helpers');

test('문서가 통째로 복제되면(front matter 2개) lint가 거부한다', () => {
  // 파싱 정규식은 non-greedy라 첫 블록만 읽고, section()도 첫 매치만 본다 —
  // 그래서 복제분은 아무 검사도 받지 못한 채 lint가 초록으로 통과했다.
  const result = cli(fixture(share() + share()), ['lint']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /두 번째 front matter/);
});

test("구현자가 String.replace로 본문을 갈아끼우다 '$`'를 흘린 손상을 잡는다", () => {
  // 실제 사고 재현: '$`'는 JS replace에서 "매치 앞부분 전체"로 치환되는 특수 토큰이라
  // 새 본문에 그대로 들어가면 문서 앞부분이 통째로 복제된다.
  const source = share();
  const corrupted = source.replace('- 실제 요구사항', '- 새 요구사항 $`');
  assert.ok(corrupted.length > source.length * 1.5, '복제가 실제로 일어나야 한다');
  const result = cli(fixture(corrupted), ['lint']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /문서 복제 의심/);
});

test('본문의 --- 수평선은 front matter로 오인하지 않는다', () => {
  const source = share().replace('### 영향 범위', '---\n\n## 참고 절\n\n### 영향 범위');
  assert.equal(cli(fixture(source), ['lint']).status, 0);
});

test('코드 펜스 안의 front matter 예시는 오탐하지 않는다', () => {
  // 프로토콜 문서를 인용하는 TASK.md가 실제로 있을 수 있다.
  const example = ['```yaml', '---', 'status: READY', 'highRisk: false', '---', '```'].join('\n');
  const source = share().replace('- 실제 불변식', `- 실제 불변식\n\n${example}`);
  const result = cli(fixture(source), ['lint']);
  assert.equal(result.status, 0, result.stderr);
});

test('strayFrontMatter는 위반 줄 번호를 돌려주고 정상 본문에는 0을 돌려준다', () => {
  assert.equal(strayFrontMatter('\n# 제목\n\n---\n\n## 절\n'), 0);
  assert.equal(strayFrontMatter('\n# 제목\n---\nstatus: READY\n'), 3);
});

test('손상된 TASK.md는 show도 거부해 handoff 실측이 이를 통과시키지 않는다', () => {
  // dispatcher의 measureRepository는 task show/lint로 성공을 판정한다. 여기서 통과하면
  // 손상된 상태가 REVIEW 도달로 인정된다.
  const file = fixture(share() + share());
  assert.equal(cli(file, ['show']).status, 1);
  assert.throws(() => parseSource(fs.readFileSync(file, 'utf8')), /두 번째 front matter/);
});
