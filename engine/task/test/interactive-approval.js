const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { share, TASK_CLI } = require('./helpers');
const { parseSource } = require('../lib');

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('실제 대화형 터미널에서 실행해야 합니다.');
  process.exit(1);
}
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tty-'));
const file = path.join(dir, 'TASK.md');
fs.writeFileSync(file, share().replace('status: PASSED\n  failedCount', 'status: PARTIAL\n  failedCount'));
try {
  const result = spawnSync(process.execPath, [TASK_CLI, 'approve-partial'], { stdio: 'inherit', env: { ...process.env, TASK_STATE_FILE: file } });
  if (result.status !== 0 || parseSource(fs.readFileSync(file, 'utf8')).data.verification.partialApproved !== true) process.exit(1);
  console.log('approve-partial 대화형 승인: PASS');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
