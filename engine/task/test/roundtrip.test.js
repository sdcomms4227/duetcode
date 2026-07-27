const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { parseSource } = require('../lib');
const { BODY, fixture, cli } = require('./helpers');

test('front matter 수정 후 주석과 키 순서를 보존한다', () => {
  const file = fixture(); const result = cli(file, ['set', 'objective=변경된 목표']); assert.equal(result.status, 0, result.stderr);
  const source = fs.readFileSync(file, 'utf8'); assert.match(source, /id: task-test # 보존할 주석/);
  assert.ok(source.indexOf('id:') < source.indexOf('status:')); assert.equal(parseSource(source).data.objective, '변경된 목표');
});

test('Markdown 본문 바이트를 그대로 보존한다', () => {
  const file = fixture(); const before = parseSource(fs.readFileSync(file, 'utf8')).body;
  assert.equal(cli(file, ['set', 'objective=본문 보존']).status, 0);
  const after = parseSource(fs.readFileSync(file, 'utf8')).body; assert.equal(after, before); assert.equal(after, BODY);
});
