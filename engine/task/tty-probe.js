#!/usr/bin/env node
if (process.argv.includes('--assert-interactive')) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(1);
  console.log('TTY interactive: PASS');
} else if (process.argv.includes('--assert-redirected')) {
  if (process.stdin.isTTY && process.stdout.isTTY) process.exit(1);
  console.log('TTY redirected: PASS');
} else {
  console.log(JSON.stringify({ stdin: !!process.stdin.isTTY, stdout: !!process.stdout.isTTY }));
}
