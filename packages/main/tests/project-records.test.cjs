const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, test } = require('node:test');

const repoRoot = join(__dirname, '..', '..', '..');
let checkProjectRecords;
let requiredFiles;
let templateFiles;

before(async () => {
  const module = await import(pathToFileURL(join(repoRoot, 'deploy', 'check-project-records.mjs')).href);
  checkProjectRecords = module.checkProjectRecords;
  requiredFiles = module.REQUIRED_FILES;
  templateFiles = module.TEMPLATE_FILES;
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lyra-project-records-'));
  for (const file of requiredFiles) {
    const absolute = join(root, file);
    mkdirSync(dirname(absolute), { recursive: true });
    if (file === '.gitignore') {
      writeFileSync(absolute, '/NOW.local.md\n/MAP.local.md\n/RUNBOOK.local.md\n');
    } else if (file === 'PROJECT_INDEX.md') {
      writeFileSync(absolute, `# Index\n\n${'x'.repeat(2100)}\n`);
    } else {
      writeFileSync(absolute, `# ${file}\n`);
    }
  }
  mkdirSync(join(root, 'history'));
  writeFileSync(join(root, 'history', '2026-11.md'), '# History\n');
  return root;
}

function withoutTemp(root, run) {
  try {
    run();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('current repository project records pass the gate', () => {
  const result = checkProjectRecords(repoRoot);
  assert.deepEqual(result.violations, [], JSON.stringify(result.violations, null, 2));
  assert.ok(result.checkedLinks > 0);
});

test('valid minimal fixture passes and shared templates are not personal local files', () => {
  const root = fixture();
  withoutTemp(root, () => {
    const result = checkProjectRecords(root, { git: false, trackedFiles: templateFiles });
    assert.deepEqual(result.violations, []);
  });
});

test('tracked personal local files are rejected', () => {
  const root = fixture();
  withoutTemp(root, () => {
    const result = checkProjectRecords(root, { git: false, trackedFiles: ['NOW.local.md'] });
    assert.ok(result.violations.some(item => item.rule === 'tracked-local-file' && item.file === 'NOW.local.md'));
  });
});

test('personal Git state and actual worktree paths are rejected in shared NOW and MAP', () => {
  const root = fixture();
  withoutTemp(root, () => {
    writeFileSync(join(root, 'NOW.md'), '当前分支 / HEAD：feat/x@abcdef1\nbehind 2\n/Users/example/repo\n');
    writeFileSync(join(root, 'MAP.md'), '../lyra-private-topic\n');
    const rules = checkProjectRecords(root, { git: false, trackedFiles: [] }).violations.map(item => item.rule);
    for (const rule of ['personal-git-head', 'personal-commit-snapshot', 'personal-git-divergence', 'personal-absolute-path', 'personal-worktree-path']) {
      assert.ok(rules.includes(rule), `缺少规则 ${rule}：${rules.join(', ')}`);
    }
  });
});

test('broken links and trailing whitespace are rejected with their line numbers', () => {
  const root = fixture();
  withoutTemp(root, () => {
    writeFileSync(join(root, 'RUNBOOK.md'), '# Runbook\n[bad](missing.md)\nspace \n');
    const result = checkProjectRecords(root, { git: false, trackedFiles: [] });
    assert.ok(result.violations.some(item => item.rule === 'missing-link' && item.line === 2));
    assert.ok(result.violations.some(item => item.rule === 'trailing-whitespace' && item.line === 3));
  });
});

test('missing ignore rules and undersized project index are rejected', () => {
  const root = fixture();
  withoutTemp(root, () => {
    writeFileSync(join(root, '.gitignore'), '/NOW.local.md\n/RUNBOOK.local.md\n');
    writeFileSync(join(root, 'PROJECT_INDEX.md'), '# too small\n');
    const rules = checkProjectRecords(root, { git: false, trackedFiles: [] }).violations.map(item => item.rule);
    assert.ok(rules.includes('missing-ignore'));
    assert.ok(rules.includes('index-size'));
  });
});

test('CI and package scripts expose the same project records gate', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  assert.match(workflow, /^  project-records:/m);
  assert.match(workflow, /run: npm run docs:check/);
  assert.match(workflow, /^permissions:\n  contents: read/m);
  assert.equal(packageJson.scripts['docs:check'], 'node deploy/check-project-records.mjs');
});
