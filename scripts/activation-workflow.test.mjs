import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const workflow = await readFile(new URL('../.github/workflows/activate.yml', import.meta.url), 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return '';
  throw error;
});
const job = (name) => {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  const remaining = workflow.slice(start + 1);
  const next = remaining.slice(1).search(/\n  [a-z][a-z-]+:\n/);
  return start < 0 ? '' : next < 0 ? remaining : remaining.slice(0, next + 1);
};

test('activation verifies an existing release without signing or publishing one', () => {
  assert.deepEqual([...workflow.slice(workflow.indexOf('jobs:')).matchAll(/^  ([a-z][a-z-]+):$/gm)].map((match) => match[1]), ['validate', 'verify-artifacts', 'promote-feed', 'deploy-pages', 'verify-pages']);
  assert.doesNotMatch(workflow, /secrets\.|gh release (create|edit|upload)|notarytool submit|tauri signer sign|workflow_call:|pull_request:/);
  assert.match(job('validate'), /GITHUB_REPOSITORY.*Epoch-ML\/ztc-releases/);
  assert.match(job('validate'), /GITHUB_REF.*refs\/heads\/main/);
  assert.match(workflow, /group: zterm-desktop-release\n  cancel-in-progress: false/);
});

test('public immutable metadata, exact assets and signatures gate activation', () => {
  const verify = job('verify-artifacts');
  assert.match(verify, /contents: read/);
  assert.match(verify, /\.draft == false and\n             \.immutable == true/);
  assert.match(verify, /published release must contain exactly eight canonical assets/);
  assert.ok(verify.includes(`if [[ "$(jq '.assets | length' "$release_json")" -ne "${'${#expected_assets[@]}'}" ]]; then`));
  assert.match(verify, /--max-filesize "\$maximum_bytes"/);
  assert.match(verify, /verify-release-payload\.mjs/);
  assert.match(verify, /minisign -Vm verified-release\/release\.json/);
  assert.match(verify, /minisign -Vm verified-release\/ztc\.app\.tar\.gz/);
  assert.match(verify, /archive exceeds expanded-size bound/);
  assert.match(verify, /Mach-O architecture must be 64-bit arm64/);
  assert.match(verify, /inspect-bundle\.mjs/);
  assert.match(verify, /release tag moved during canonical asset verification/);
});

test('only verified payloads can update the monotonic feed using the repository token', () => {
  const promote = job('promote-feed');
  assert.match(promote, /needs:\n      - validate\n      - verify-artifacts/);
  assert.match(promote, /contents: write/);
  assert.match(promote, /token: \$\{\{ github\.token \}\}/);
  assert.match(promote, /check-install-readiness\.mjs/);
  assert.match(promote, /cmp "\$RUNNER_TEMP\/install-ztc\.sh" policy\/install-ztc\.sh/);
  assert.match(promote, /node policy\/scripts\/feed-policy\.mjs/);
  assert.match(promote, /git -C data push origin HEAD:release-data/);
  assert.doesNotMatch(promote, /--force/);
});

test('Pages deployment verifies both updater files and both public catalog files', () => {
  assert.match(job('deploy-pages'), /needs: promote-feed/);
  assert.match(job('deploy-pages'), /id-token: write/);
  assert.match(job('deploy-pages'), /run: node scripts\/deploy-pages\.mjs/);
  const verify = job('verify-pages');
  for (const file of ['latest.json', 'release-metadata.json', 'release.json', 'release.json.sig']) {
    assert.ok(verify.includes(`cmp --silent payload/${file} `), `the exact ${file} bytes must be checked after deployment`);
  }
});

function preparationScript() {
  const marker = '      - name: Prepare isolated release-data branch\n';
  const start = workflow.indexOf(marker);
  if (start < 0) return 'echo "release-data preparation not implemented" >&2\nexit 1\n';
  const runStart = workflow.indexOf('        run: |\n', start) + '        run: |\n'.length;
  const end = workflow.indexOf('\n      - ', runStart);
  return workflow.slice(runStart, end).split('\n').map((line) => line.slice(10)).join('\n');
}

async function fixture(action) {
  const root = await mkdtemp(join(tmpdir(), 'ztc-activation-'));
  try {
    const remote = join(root, 'remote.git');
    const data = join(root, 'data');
    await exec('git', ['init', '--bare', remote]);
    await exec('git', ['clone', remote, data]);
    await exec('git', ['config', 'user.name', 'Release test'], { cwd: data });
    await exec('git', ['config', 'user.email', 'release-test@example.invalid'], { cwd: data });
    await writeFile(join(data, 'source-only.txt'), 'source tree\n');
    await exec('git', ['add', '.'], { cwd: data });
    await exec('git', ['commit', '-m', 'Seed source'], { cwd: data });
    await mkdir(join(root, 'policy', 'site'), { recursive: true });
    await writeFile(join(root, 'policy', 'site', 'index.html'), 'ZTC downloads\n');
    await action({ root, data, remote });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('first activation prepares only the static site without publishing the branch early', async () => {
  await fixture(async ({ root, data, remote }) => {
    await exec('bash', ['-c', preparationScript()], { cwd: root, env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: join(root, 'env') } });
    assert.equal((await exec('git', ['branch', '--show-current'], { cwd: data })).stdout.trim(), 'release-data');
    assert.equal(await readFile(join(data, 'site', 'index.html'), 'utf8'), 'ZTC downloads\n');
    assert.equal((await exec('git', ['diff', '--cached', '--name-only'], { cwd: data })).stdout.trim(), 'site/index.html');
    await assert.rejects(readFile(join(data, 'source-only.txt')), { code: 'ENOENT' });
    assert.equal((await exec('git', ['for-each-ref', '--format=%(refname)', 'refs/heads/release-data'], { cwd: remote })).stdout, '');
  });
});

test('later activation retains existing channel history instead of reseeding it', async () => {
  await fixture(async ({ root, data }) => {
    await exec('git', ['checkout', '-b', 'release-data'], { cwd: data });
    await mkdir(join(data, 'site'), { recursive: true });
    await writeFile(join(data, 'site', 'existing-release.json'), '{"version":"0.4.0"}\n');
    await exec('git', ['add', '.'], { cwd: data });
    await exec('git', ['commit', '-m', 'Existing feed'], { cwd: data });
    await exec('git', ['push', 'origin', 'release-data'], { cwd: data });
    await exec('git', ['checkout', '-'], { cwd: data });
    await exec('bash', ['-c', preparationScript()], { cwd: root, env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: join(root, 'env') } });
    assert.equal(await readFile(join(data, 'site', 'existing-release.json'), 'utf8'), '{"version":"0.4.0"}\n');
    await assert.rejects(readFile(join(data, 'site', 'index.html')), { code: 'ENOENT' });
    assert.match(await readFile(join(root, 'env'), 'utf8'), /RELEASE_DATA_EXISTS=true/);
  });
});

test('a failed remote lookup cannot reset feed history or bootstrap a new feed', async () => {
  await fixture(async ({ root, data }) => {
    await exec('git', ['remote', 'set-url', 'origin', join(root, 'missing-remote.git')], { cwd: data });
    await assert.rejects(exec('bash', ['-c', preparationScript()], { cwd: root, env: { ...process.env, RUNNER_TEMP: root, GITHUB_ENV: join(root, 'env') } }), (error) => error.code !== 0 && /Unable to read release-data ref/.test(error.stderr));
    assert.equal(await readFile(join(data, 'source-only.txt'), 'utf8'), 'source tree\n');
    assert.notEqual((await exec('git', ['branch', '--show-current'], { cwd: data })).stdout.trim(), 'release-data');
  });
});
