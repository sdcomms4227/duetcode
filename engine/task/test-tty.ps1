$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$probe = Join-Path $PSScriptRoot 'tty-probe.js'

Write-Host '대화형 approve-partial 검사는 각 셸의 실제 터미널에서 아래 명령을 직접 실행하고 APPROVE를 입력합니다.'
Write-Host 'PowerShell: node tools/task/test/interactive-approval.js'
Write-Host 'cmd:        node tools\task\test\interactive-approval.js'
Write-Host 'Git Bash:   node tools/task/test/interactive-approval.js'

'' | node $probe --assert-redirected
cmd /d /c "echo.|node tools\task\tty-probe.js --assert-redirected"
$gitBash = if (Test-Path 'C:\Program Files\Git\bin\bash.exe') { 'C:\Program Files\Git\bin\bash.exe' } else { (Get-Command bash -ErrorAction Stop).Source }
& $gitBash -lc "printf x | node tools/task/tty-probe.js --assert-redirected"
if ($LASTEXITCODE -ne 0) { throw 'TTY redirect 검사 실패' }
Write-Host 'PowerShell/cmd/Git Bash redirect 검사: PASS'
