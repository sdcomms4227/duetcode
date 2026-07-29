const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const YAML = require('yaml');

const STATES = ['IDLE', 'DESIGN', 'READY', 'IMPLEMENTING', 'REVIEW', 'DONE', 'BLOCKED', 'CANCELLED', 'SUPERSEDED'];
const ACTIVE = ['DESIGN', 'READY', 'IMPLEMENTING', 'REVIEW'];
const TERMINAL = ['DONE', 'CANCELLED', 'SUPERSEDED'];
const TRANSITIONS = { IDLE: ['DESIGN'], DESIGN: ['READY'], READY: ['IMPLEMENTING'], IMPLEMENTING: ['REVIEW'], REVIEW: ['DONE', 'IMPLEMENTING', 'READY'] };
const EMPTY_VERIFICATION = () => ({ status: null, failedCount: 0, partialApproved: false, approvedBy: null, approvedAt: null, updated: null, evidence: null });
// start 시 '## Active Task' 이하 본문을 이 스켈레톤으로 교체해 이전 Task 본문(stale) 잔존을 원천 차단한다.
// 플레이스홀더 '미정'은 blank()/meaningful()이 빈 것으로 간주하므로, 설계자가 실제 내용으로 교체하기 전에는 READY lint가 거부된다.
const STARTER_BODY = `(설계자가 이 아래를 새 업무 내용으로 작성한다. 아래 플레이스홀더는 READY 전환 전에 실제 내용으로 교체해야 하며, 미교체 시 lint가 READY를 거부한다.)

### 요구사항과 완료 조건

- 미정

### 필독 문서와 불변식

- 미정

### 영향 범위

- 미정

### 확정된 설계와 미확정 사항

- 미정

### 구현 및 설계 차이

- 미정

### 검증 결과

- 미정

### Review와 다음 행동

- **다음 담당자**: 미정
- **다음 행동**: 미정
`;
const now = () => new Date().toISOString();
function fail(message) { throw new Error(message); }
// TASK.md의 front matter는 정확히 하나여야 한다. 파싱 정규식은 non-greedy라 첫 블록만 읽고 나머지를
// 전부 본문으로 넘기며, section()도 indexOf로 첫 매치만 본다 — 그래서 문서가 통째로 복제돼도(front matter가
// 둘이어도) 복제분은 어떤 검사도 받지 않고 lint가 초록으로 통과했다. 실제로 구현자가 JS String.replace로
// 본문을 갈아끼우다 '$`'(매치 앞부분 전체로 치환되는 특수 토큰)를 흘려 문서가 복제된 사고가 있었고,
// lint는 그 손상을 잡지 못했다. 여기서 "본문 안의 두 번째 front matter"를 거부해 그 구멍을 막는다.
// 본문의 '---' 수평선은 다음 줄이 YAML 키일 때만 걸리고, 코드 펜스 안은 아예 보지 않는다(예시 YAML 오탐 방지).
const FRONT_MATTER_KEYS = /^(id|status|objective|requester|roles|branch|designCheckpoint|issue|highRisk|verification|blocked|closure|updated)\s*:/;
function strayFrontMatter(body) {
  const lines = body.split(/\r?\n/);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const opener = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (opener) {
      if (fence == null) fence = opener[1][0];
      else if (opener[1][0] === fence) fence = null;
      continue;
    }
    if (fence != null) continue;
    // (1) front matter 전용 키가 열 0에 나온다 = 복제된 front matter의 잔해. 산문 항목은 '- '나 들여쓰기로
    //     시작하므로 열 0 키는 정상 본문에 나오지 않는다. '$`' 사고처럼 여는 '---'가 앞 줄 끝에 붙어버려
    //     구분자가 온전하지 않은 손상도 이 규칙으로 잡힌다(키는 그대로 열 0에 남는다).
    if (FRONT_MATTER_KEYS.test(line)) return index + 1;
    // (2) 온전한 '---' + YAML 키 = 문서가 통째로 덧붙은 형태. 본문의 '---' 수평선은 다음 줄이 키가 아니라 통과한다.
    if (/^---\s*$/.test(line) && /^[A-Za-z_][\w-]*\s*:(\s|$)/.test(lines[index + 1] ?? '')) return index + 1;
  }
  return 0;
}
function parseSource(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n[\s\S]*)$/);
  if (!match) fail('TASK.md 최상단에 YAML front matter가 필요합니다.');
  const duplicated = strayFrontMatter(match[2]);
  if (duplicated) fail(`본문 ${duplicated}번째 줄에 두 번째 front matter가 있습니다(문서 복제 의심). TASK.md의 front matter는 하나여야 합니다 — 중복 블록과 그 아래 복제 본문을 지우고 다시 실행하세요.`);
  const doc = YAML.parseDocument(match[1], { keepSourceTokens: true, prettyErrors: true });
  if (doc.errors.length) fail(`front matter YAML 오류: ${doc.errors[0].message}`);
  return { doc, data: doc.toJS(), body: match[2] };
}
// 저장소 루트를 위치 추론이 아니라 명시적으로 해석한다(DUET_REPO_ROOT → git → cwd). 폴백했다는 사실을
// source로 돌려주므로 호출자가 조용히 삼키지 않을 수 있다. handoff/lib.js가 이것을 그대로 재사용한다 —
// 두 엔진이 서로 다른 저장소 루트를 계산하면 같은 명령이 다른 TASK.md를 건드리게 된다.
function resolveRepoRoot(env = process.env, cwd = process.cwd()) {
  if (env.DUET_REPO_ROOT) return { root: path.resolve(env.DUET_REPO_ROOT), source: 'env' };
  const found = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', windowsHide: true });
  const top = (found.stdout || '').trim();
  if (found.status === 0 && top) return { root: path.resolve(top), source: 'git' };
  return { root: path.resolve(cwd), source: 'cwd' };
}
// TASK.md의 위치를 해석한다. 예전에는 cwd 상대 'TASK.md' 하나뿐이라, 서브디렉터리에서 duet-task를 부르면
// 저장소의 TASK.md를 찾지 못하고 실패했다 — 같은 저장소에서 duet-handoff는 찾는데(자체 repo root 해석),
// 두 엔진의 동작이 갈려 있었다. 탐색 순서는 기존 동작을 그대로 보존하도록 잡는다:
// 명시 지정(TASK_STATE_FILE) → cwd → 저장소 루트. cwd가 항상 우선이므로 루트에서 실행하던 기존 호출은
// 결과가 바뀌지 않고, 지금까지 실패하던 서브디렉터리 호출만 성공으로 바뀐다.
function resolveTaskFile(env = process.env, cwd = process.cwd()) {
  if (env.TASK_STATE_FILE) return env.TASK_STATE_FILE;
  const local = path.resolve(cwd, 'TASK.md');
  if (fs.existsSync(local)) return local;
  const rooted = path.join(resolveRepoRoot(env, cwd).root, 'TASK.md');
  if (fs.existsSync(rooted)) return rooted;
  return local; // 어디에도 없으면 원래 자리를 가리켜, 오류 메시지가 사용자가 선 곳을 말하게 한다
}
function load(file = resolveTaskFile()) {
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fail(`TASK.md를 찾을 수 없습니다: ${file}\n저장소 루트에서 실행하거나 TASK_STATE_FILE로 경로를 지정하세요.`);
  }
  return { file, source, ...parseSource(source) };
}
// 임시 파일에 쓴 뒤 rename한다. TASK.md는 파이프라인 전체가 걸린 단일 소스인데, 직접 덮어쓰면
// 쓰기 도중 죽었을 때 반쯤 쓰인 파일이 남아 lint·show·handoff가 전부 막힌다.
// (핸드오프 쪽 writeJson은 처음부터 이 방식이었다 — 같은 저장소 안에서 원자성 규율이 갈려 있었다.)
function save(model) {
  model.doc.set('updated', now());
  const content = `---\n${model.doc.toString().trimEnd()}\n---${model.body}`;
  const temporary = `${model.file}.${process.pid}.${process.hrtime.bigint()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, 'utf8');
    fs.renameSync(temporary, model.file);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch { /* 실패한 임시 파일 정리는 best-effort */ }
    throw error;
  }
}
const get = (model, key) => model.doc.getIn(key.split('.'));
const set = (model, key, value) => model.doc.setIn(key.split('.'), value);
function git(args) { return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
// 설계가 아직 안 채워졌다고 볼 자리표시자. lint(meaningful)와 핸드오프 프롬프트 조립이 같은 목록을
// 봐야 한다 — 목록이 두 벌이면 한쪽만 고쳤을 때 두 게이트의 판정이 조용히 갈린다.
const PLACEHOLDER_VALUES = ['없음', '미정', 'TODO', '-'];
const blank = value => value == null || (typeof value === 'string' && (!value.trim() || PLACEHOLDER_VALUES.includes(value.trim())));
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value));
function section(body, title) {
  const start = body.indexOf(`### ${title}`); if (start < 0) return '';
  const rest = body.slice(start + title.length + 4); const end = rest.search(/\r?\n### /); return end < 0 ? rest : rest.slice(0, end);
}
// 섹션 본문 하나가 실제 내용을 담고 있는지 판정한다. 불릿(- / *)만 값으로 인정하고, '- ' 와
// '**라벨**:' 를 걷어낸 나머지가 자리표시자면 비어 있는 것으로 본다.
// handoff의 build-prompt가 이 함수를 그대로 쓴다 — 예전에는 각자 구현이라 실제로 판정이 달랐다
// (불릿 없는 산문 섹션을 build-prompt는 통과시키고 lint는 거부했다).
function meaningfulContent(content) {
  return content.split(/\r?\n/).some(line => {
    if (!/^\s*[-*]\s+/.test(line)) return false;
    const v = line.replace(/^\s*[-*]\s*/, '').replace(/^\*\*[^*]+\*\*:\s*/, '').trim();
    return v && !PLACEHOLDER_VALUES.includes(v);
  });
}
function meaningful(body, title) { return meaningfulContent(section(body, title)); }
function labelled(body, label) {
  const line = section(body, 'Review와 다음 행동').split(/\r?\n/).find(value => new RegExp(`^\\s*[-*]\\s+\\*\\*${label}\\*\\*:`).test(value));
  if (!line) return false;
  const value = line.slice(line.indexOf(':') + 1).trim();
  return !blank(value);
}
function canDone(v) { return !!v && v.failedCount === 0 && (v.status === 'PASSED' || (v.status === 'PARTIAL' && v.partialApproved === true)); }
function validate(data, body) {
  const errors = [];
  if (!STATES.includes(data.status)) errors.push(`status가 유효하지 않습니다: ${data.status}`);
  if (typeof data.highRisk !== 'boolean') errors.push('highRisk는 boolean이어야 합니다.');
  if (!iso(data.updated)) errors.push('updated는 ISO 8601 일시여야 합니다.');
  if (!(data.issue == null || (Number.isInteger(data.issue) && data.issue > 0))) errors.push('issue는 양의 정수 또는 null이어야 합니다.');
  if (data.status === 'IDLE') {
    for (const key of ['id', 'objective', 'requester', 'roles', 'designCheckpoint', 'issue', 'verification', 'blocked', 'closure']) if (data[key] != null) errors.push(`IDLE에서는 ${key}가 null 또는 생략이어야 합니다.`);
    if (blank(data.branch)) errors.push('IDLE에서도 branch가 필요합니다.');
  }
  else {
    for (const key of ['id', 'objective', 'requester', 'branch']) if (blank(data[key])) errors.push(`${key} 필드가 필요합니다.`);
    if (blank(data.roles?.designer)) errors.push('roles.designer가 필요합니다.');
    if (['READY', 'IMPLEMENTING', 'REVIEW', 'DONE'].includes(data.status)) {
      for (const role of ['implementer', 'reviewer']) if (blank(data.roles?.[role])) errors.push(`roles.${role}가 필요합니다.`);
      if (blank(data.designCheckpoint)) errors.push('designCheckpoint가 필요합니다.');
      for (const title of ['요구사항과 완료 조건', '필독 문서와 불변식', '영향 범위', '확정된 설계와 미확정 사항']) if (!meaningful(body, title)) errors.push(`'${title}' 섹션이 비어 있습니다.`);
    }
  }
  if (data.highRisk && !String(data.roles?.designer).includes('Opus')) errors.push('highRisk의 designer에는 Opus가 포함되어야 합니다.');
  if (data.highRisk && ['READY', 'IMPLEMENTING', 'REVIEW', 'DONE'].includes(data.status) && !String(data.roles?.reviewer).includes('Opus')) errors.push('highRisk의 reviewer에는 Opus가 포함되어야 합니다.');
  if (data.status === 'BLOCKED') { if (!data.blocked || !ACTIVE.includes(data.blocked.previousStatus) || blank(data.blocked.reason) || !iso(data.blocked.since)) errors.push('blocked 블록이 유효하지 않습니다.'); }
  else if (data.blocked != null) errors.push('BLOCKED가 아니면 blocked는 null이어야 합니다.');
  if (['CANCELLED', 'SUPERSEDED'].includes(data.status)) {
    if (!data.closure || data.closure.type !== data.status || blank(data.closure.reason) || !iso(data.closure.at) || !(data.closure.archiveRef == null || typeof data.closure.archiveRef === 'string')) errors.push('closure 블록이 유효하지 않습니다.');
    if (data.status === 'SUPERSEDED' && blank(data.closure?.replacementId)) errors.push('SUPERSEDED에는 replacementId가 필요합니다.');
  } else if (data.closure != null) errors.push('종결 상태가 아니면 closure는 null이어야 합니다.');
  const v = data.verification;
  if (['REVIEW', 'DONE'].includes(data.status) && !v) errors.push('REVIEW 이후 verification 객체가 필요합니다.');
  if (v != null) {
    for (const key of ['status', 'failedCount', 'partialApproved', 'approvedBy', 'approvedAt', 'updated']) if (!(key in v)) errors.push(`verification.${key}가 필요합니다.`);
    if (![null, 'PASSED', 'FAILED', 'PARTIAL'].includes(v.status)) errors.push('verification.status가 유효하지 않습니다.');
    if (!Number.isInteger(v.failedCount) || v.failedCount < 0) errors.push('verification.failedCount는 비음수 정수여야 합니다.');
    if (typeof v.partialApproved !== 'boolean') errors.push('verification.partialApproved는 boolean이어야 합니다.');
    if (v.status == null && (v.failedCount !== 0 || v.updated !== null)) errors.push('미검증 verification은 failedCount=0, updated=null이어야 합니다.');
    if (v.status != null && !iso(v.updated)) errors.push('검증 결과에는 verification.updated ISO 8601 일시가 필요합니다.');
    if (v.partialApproved) {
      if (v.status !== 'PARTIAL' || blank(v.approvedBy) || !iso(v.approvedAt)) errors.push('PARTIAL 승인의 승인자와 ISO 8601 승인 시각이 유효하지 않습니다.');
    } else if (v.approvedBy != null || v.approvedAt != null) errors.push('미승인 상태의 approvedBy/approvedAt은 null이어야 합니다.');
    // evidence는 선택 필드다(구버전 TASK.md 호환). 있으면 형식을 강제하고, 무엇보다
    // "증거가 실패를 말하는데 PASSED로 기록된" 모순을 막는다 — 그게 이 필드의 존재 이유다.
    if (v.evidence != null) {
      const e = v.evidence;
      if (typeof e !== 'object' || Array.isArray(e)) errors.push('verification.evidence는 객체 또는 null이어야 합니다.');
      else {
        if (blank(e.command)) errors.push('verification.evidence.command가 필요합니다.');
        if (!Number.isInteger(e.exitCode)) errors.push('verification.evidence.exitCode는 정수여야 합니다.');
        if (!/^[a-f0-9]{64}$/.test(String(e.outputSha256))) errors.push('verification.evidence.outputSha256은 sha256 16진 해시여야 합니다.');
        if (!iso(e.at)) errors.push('verification.evidence.at은 ISO 8601 일시여야 합니다.');
        if (v.status === 'PASSED' && e.exitCode !== 0) errors.push('PASSED인데 증거의 exitCode가 0이 아닙니다.');
      }
    }
  }
  if (['REVIEW', 'DONE'].includes(data.status)) {
    if (!labelled(body, '다음 담당자')) errors.push("'다음 담당자' 불릿이 비어 있습니다.");
    if (!labelled(body, '다음 행동')) errors.push("'다음 행동' 불릿이 비어 있습니다.");
  }
  if (data.status === 'DONE' && !canDone(data.verification)) errors.push('DONE 검증 조건을 충족하지 않습니다.');
  return errors;
}
function transition(model, target, checkpoint) {
  const from = get(model, 'status');
  if (!(TRANSITIONS[from] || []).includes(target)) fail(`허용되지 않은 전환: ${from} → ${target}`);
  if (target === 'DONE' && !canDone(model.doc.toJS().verification)) fail('DONE 검증 조건을 충족하지 않습니다.');
  if (target === 'REVIEW') set(model, 'verification', EMPTY_VERIFICATION());
  if (from === 'REVIEW' && ['IMPLEMENTING', 'READY'].includes(target)) {
    if (target === 'READY' && blank(checkpoint)) fail('REVIEW → READY에는 --design-checkpoint가 필요합니다.');
    set(model, 'verification', EMPTY_VERIFICATION());
    if (target === 'READY') set(model, 'designCheckpoint', checkpoint);
  }
  set(model, 'status', target);
}
// issue-sync는 이 CLI의 유일한 비가역 외부 쓰기다. 그래서 다른 명령과 두 가지가 다르다.
// (1) 호출자는 gh를 부르기 전에 validate를 통과시켜야 한다 — 공통 lint는 gh 호출보다 뒤라서, 무효한 상태가
//     이미 Issue에 게시된 뒤에야 걸렸다(되돌릴 수 없다). 검증은 외부 쓰기보다 앞이어야 한다.
// (2) 코멘트를 무조건 새로 달지 않고 마커로 기존 것을 찾아 갱신한다. 게시 성공 후 save()가 실패하면
//     archiveRef가 남지 않아 재실행하게 되는데, 그때 새 코멘트가 또 달리면 같은 Task로 Issue가 도배된다.
const issueSyncMarker = id => `<!-- duetcode:issue-sync ${id} -->`;
function issueSyncBody(data) {
  return [issueSyncMarker(data.id), `Task: ${data.id}`, `Status: ${data.status}`, `Verification: ${JSON.stringify(data.verification)}`, `Closure: ${JSON.stringify(data.closure)}`].join('\n');
}
function findIssueSyncComment(listed, id) {
  let comments;
  try { comments = JSON.parse(listed); } catch { fail('기존 코멘트 목록을 해석하지 못해 중복 게시를 피할 수 없습니다.'); }
  if (!Array.isArray(comments)) fail('기존 코멘트 목록이 배열이 아닙니다.');
  const marker = issueSyncMarker(id);
  const found = comments.filter(comment => typeof comment?.body === 'string' && comment.body.includes(marker));
  // 여러 개면 갱신 대상이 모호하다. 임의로 하나를 고르면 나머지는 낡은 상태로 남아 Issue가 서로 모순된 내용을 갖는다.
  if (found.length > 1) fail(`이 Task의 동기화 코멘트가 ${found.length}개입니다. 사람이 정리한 뒤 다시 실행하세요.`);
  return found[0] ?? null;
}
// gh(args) → stdout 문자열. 실패는 던진다(호출자가 처리). 목록 조회 실패 시 새로 달지 않는 fail-closed다 —
// 기존 코멘트를 확인하지 못한 채 게시하면 중복을 막을 수 없기 때문이다.
function syncIssueComment(data, issue, gh) {
  const body = issueSyncBody(data);
  const existing = findIssueSyncComment(gh(['api', `repos/{owner}/{repo}/issues/${issue}/comments`, '--paginate']), data.id);
  if (existing) {
    gh(['api', `repos/{owner}/{repo}/issues/comments/${existing.id}`, '-X', 'PATCH', '-f', `body=${body}`]);
    return { action: 'updated', id: existing.id };
  }
  gh(['issue', 'comment', String(issue), '--body', body]);
  return { action: 'created', id: null };
}
const snapshot = d => ({ id: d.id, status: d.status, type: d.closure?.type, reason: d.closure?.reason, replacementId: d.closure?.replacementId ?? null });
const same = (a, b) => JSON.stringify(snapshot(a)) === JSON.stringify(snapshot(b));
function verifyArchiveRef(model, ref) {
  const current = model.doc.toJS();
  if (!['CANCELLED', 'SUPERSEDED'].includes(current.status)) fail('archive는 CANCELLED/SUPERSEDED에서만 허용됩니다.');
  if (ref.startsWith('issue:')) fail('issue: 참조는 issue-sync로만 설정할 수 있습니다.');
  if (ref.startsWith('commit:')) {
    const sha = ref.slice(7); let archived;
    try { git(['cat-file', '-e', `${sha}^{commit}`]); archived = parseSource(git(['show', `${sha}:TASK.md`])).data; } catch { fail(`유효한 TASK.md 커밋이 아닙니다: ${sha}`); }
    if (!same(current, archived)) fail('커밋의 Task/closure가 현재 값과 일치하지 않습니다.'); return;
  }
  if (ref.startsWith('docs:')) {
    const file = ref.slice(5);
    try { git(['ls-files', '--error-unmatch', file]); } catch { fail('archive 문서는 Git 추적 파일이어야 합니다.'); }
    if (git(['status', '--porcelain', '--', file])) fail('archive 문서에 미커밋 변경이 있습니다.');
    const match = fs.readFileSync(file, 'utf8').match(/<!-- TASK-ARCHIVE\s*\n([\s\S]*?)\n-->/);
    if (!match || !same(current, YAML.parse(match[1]))) fail('canonical TASK-ARCHIVE 블록이 현재 Task/closure와 일치하지 않습니다.'); return;
  }
  fail('archive 참조는 commit:<sha> 또는 docs:<path>여야 합니다.');
}
// '## Active Task' 헤딩 이하를 STARTER_BODY로 교체한다(헤딩 위 인트로/제목은 보존). 헤딩이 없으면 최소 골격을 재구성한다.
function resetBody(model) {
  const marker = '## Active Task';
  const idx = model.body.indexOf(marker);
  if (idx >= 0) model.body = `${model.body.slice(0, idx + marker.length)}\n\n${STARTER_BODY}`;
  else model.body = `\n\n# TASK.md — Active Task 상태\n\n## Active Task\n\n${STARTER_BODY}`;
}
module.exports = { ACTIVE, TERMINAL, resolveRepoRoot, resolveTaskFile, PLACEHOLDER_VALUES, meaningfulContent, meaningful, EMPTY_VERIFICATION, STARTER_BODY, now, fail, load, save, get, set, git, validate, transition, verifyArchiveRef, parseSource, resetBody, issueSyncMarker, issueSyncBody, findIssueSyncComment, syncIssueComment, strayFrontMatter };
