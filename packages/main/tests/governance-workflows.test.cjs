const assert = require('node:assert/strict');
const { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');
const { before, test } = require('node:test');

const repoRoot = join(__dirname, '..', '..', '..');
const workflowsDir = join(repoRoot, '.github', 'workflows');

let scanWorkflowSource;
let checkWorkflows;

before(async () => {
  const module = await import(pathToFileURL(join(repoRoot, 'deploy', 'check-workflows-readonly.mjs')).href);
  scanWorkflowSource = module.scanWorkflowSource;
  checkWorkflows = module.checkWorkflows;
});

test('repository workflows declare read-only permissions and release automation is removed', () => {
  const { files, violations } = checkWorkflows(workflowsDir);
  assert.ok(files.length >= 2, '至少应存在 CI 与 Copilot 工作流');
  assert.ok(!files.includes('release-docker.yml'), 'release-docker.yml 必须删除，发布改走离线脚本');
  assert.deepEqual(violations, [], `实际工作流存在违规：${JSON.stringify(violations, null, 2)}`);

  for (const file of files) {
    const source = readFileSync(join(workflowsDir, file), 'utf8');
    assert.match(source, /^permissions:/m, `${file} 必须显式声明顶层 permissions`);
  }
});

test('read-only workflow with explicit permissions passes the gate', () => {
  const source = [
    'name: Read Only',
    'on: pull_request',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    permissions:',
    '      contents: read',
    '    steps:',
    '      - uses: actions/checkout@v6',
    '      - run: npm test',
    '',
  ].join('\n');
  assert.deepEqual(scanWorkflowSource(source, 'ok.yml'), []);
});

test('write-like action inputs outside permissions are not flagged', () => {
  const source = [
    'name: Read Only',
    'on: push',
    'permissions:',
    '  contents: read',
    'jobs:',
    '  verify:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: example/configure@v1',
    '        with:',
    '          mode: write',
    '',
  ].join('\n');
  assert.deepEqual(scanWorkflowSource(source, 'ok.yml'), []);
});

test('write permissions are rejected at the exact line', () => {
  const source = [
    'name: Bad',
    'on: push',
    'permissions:',
    '  contents: write',
    'jobs: {}',
    '',
  ].join('\n');
  const violations = scanWorkflowSource(source, 'bad.yml');
  assert.ok(violations.some(item => item.rule === 'permission-write' && item.line === 4));
});

const NEGATIVE_CASES = [
  {
    name: 'contents: write',
    rule: 'permission-write',
    source: 'name: Bad\non: push\npermissions:\n  contents: write\njobs: {}\n',
  },
  {
    name: 'packages: write',
    rule: 'permission-write',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\n  packages: write\njobs: {}\n',
  },
  {
    name: 'id-token: write',
    rule: 'permission-write',
    source: 'name: Bad\non: push\npermissions:\n  id-token: write\njobs: {}\n',
  },
  {
    name: 'permissions: write-all',
    rule: 'permission-write',
    source: 'name: Bad\non: push\npermissions: write-all\njobs: {}\n',
  },
  {
    name: 'inline permissions map with write',
    rule: 'permission-write',
    source: 'name: Bad\non: push\npermissions: { contents: read, pull-requests: write }\njobs: {}\n',
  },
  {
    name: 'missing top-level permissions',
    rule: 'missing-permissions',
    source: 'name: Bad\non: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ok\n',
  },
  {
    name: 'gh pr merge',
    rule: 'gh-write',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh pr merge 12 --squash\n',
  },
  {
    name: 'gh release create',
    rule: 'gh-write',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh release create v1.0.0\n',
  },
  {
    name: 'gh api write request',
    rule: 'gh-write',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: gh api -X POST /repos/owner/repo/issues -f title=bad\n',
  },
  {
    name: 'action-gh-release',
    rule: 'publish-action',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: softprops/action-gh-release@v2\n',
  },
  {
    name: 'docker build-push-action with push: true',
    rule: 'publish-action',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/build-push-action@v6\n        with:\n          push: true\n',
  },
  {
    name: 'docker/login-action',
    rule: 'publish-action',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: docker/login-action@v3\n',
  },
  {
    name: 'git push',
    rule: 'git-push',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push origin main\n',
  },
  {
    name: 'npm publish',
    rule: 'publish-action',
    source: 'name: Bad\non: push\npermissions:\n  contents: read\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish --access public\n',
  },
];

for (const { name, rule, source } of NEGATIVE_CASES) {
  test(`gate rejects ${name}`, () => {
    const violations = scanWorkflowSource(source, 'sample.yml');
    assert.ok(
      violations.some(item => item.rule === rule && item.file === 'sample.yml'),
      `${name} 必须被拦截，实际：${JSON.stringify(violations)}`,
    );
  });
}

test('gate scans every YAML file in the workflows directory', () => {
  const yamlFiles = readdirSync(workflowsDir).filter(file => /\.(yml|yaml)$/i.test(file)).sort();
  const { files } = checkWorkflows(workflowsDir);
  assert.deepEqual(files, yamlFiles);
});

test('gate discovers nested workflow YAML files', () => {
  const temp = mkdtempSync(join(tmpdir(), 'lyra-workflows-'));
  try {
    mkdirSync(join(temp, 'nested'));
    writeFileSync(
      join(temp, 'nested', 'bad.yaml'),
      'name: Bad\non: push\npermissions:\n  contents: write\njobs: {}\n',
    );
    const { files, violations } = checkWorkflows(temp);
    assert.deepEqual(files, ['nested/bad.yaml']);
    assert.ok(violations.some(item => item.file === 'nested/bad.yaml' && item.rule === 'permission-write'));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
