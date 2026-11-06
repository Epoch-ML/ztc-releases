import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const workflow = await readFile(new URL("../.github/workflows/verify.yml", import.meta.url), "utf8");
const STEP_NAME = "Bind each request a pull request adds to its npm package";
const TAG = "ztc-desktop-preview-v0.12.0-beta.1";
const REQUEST_PATH = `requests/${TAG}.json`;
const TARBALL_URL = "https://registry.npmjs.org/@zergai/ztc/-/ztc-0.12.0-beta.1.tgz";
const SOURCE_SHA = "1234567890abcdef1234567890abcdef12345678";
const NOTES = {
  whats_new: ["Panes keep the name you give them.", "Emoji with a joiner 👩\u200d💻 work."],
  changes: ["A renamed pane keeps its name in the desktop app."],
};
const NOTES_RELEASE = { whatsNew: NOTES.whats_new, changes: NOTES.changes };

// The workflow's own step text, as bash runs it on the runner.
function stepScript(name) {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `verify.yml must have the step "${name}"`);
  const runAt = workflow.indexOf("        run: |\n", start);
  assert.ok(runAt > start, `"${name}" must run a script`);
  const lines = [];
  for (const line of workflow.slice(runAt + "        run: |\n".length).split("\n")) {
    if (line !== "" && !line.startsWith("          ")) break;
    lines.push(line.slice(10));
  }
  return lines.join("\n");
}

function stepHeader(name) {
  const start = workflow.indexOf(`- name: ${name}\n`);
  assert.ok(start >= 0, `verify.yml must have the step "${name}"`);
  return workflow.slice(start, workflow.indexOf("        run: |\n", start));
}

function identity(integrity) {
  return {
    schema_version: 1,
    product: "ZTC",
    channel: "preview",
    version: "0.12.0-beta.1",
    release_tag: TAG,
    source_repository: "Epoch-ML/zerg",
    source_sha: SOURCE_SHA,
    source_ref: `refs/tags/${TAG}`,
    requested_at: "2026-11-12T18:00:00.000Z",
    npm: { name: "@zergai/ztc", version: "0.12.0-beta.1", integrity, tarballUrl: TARBALL_URL },
  };
}

function canonical(request) {
  return `${JSON.stringify(request, null, 2)}\n`;
}

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

// tar is a process boundary; COPYFILE_DISABLE keeps macOS metadata files out.
async function npmPackage(root, zergRelease) {
  const staging = join(root, "staging");
  await mkdir(join(staging, "package"), { recursive: true });
  const manifest = {
    name: "@zergai/ztc",
    version: "0.12.0-beta.1",
    zergRelease: { branch: "main", channel: "next", sourceCommit: SOURCE_SHA, ...zergRelease },
  };
  await writeFile(join(staging, "package", "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const tarball = join(root, "npm.tgz");
  await execFileAsync("tar", ["-czf", tarball, "-C", staging, "package"], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  const integrity = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  return { tarball, integrity };
}

async function commitFiles(repo, files, message) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), contents);
  }
  await execFileAsync("git", ["add", "-A"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
  await execFileAsync("git", ["commit", "-q", "--allow-empty", "-m", message], {
    cwd: repo,
    env: { ...process.env, ...GIT_ENV },
  });
}

// A checkout of a pull request's merge commit: HEAD^1 is the base it adds to.
// curl is the process boundary: it serves the package's bytes and logs the URL.
async function runBinding(t, { zergRelease = NOTES_RELEASE, base = {}, head, singleCommit = false }) {
  const root = await mkdtemp(join(tmpdir(), "ztc-verify-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { tarball, integrity } = await npmPackage(root, zergRelease);
  const repo = join(root, "repo");
  await mkdir(join(repo, "scripts"), { recursive: true });
  for (const script of ["release-request.mjs", "public-release.mjs"]) {
    await copyFile(join(SCRIPTS, script), join(repo, "scripts", script));
  }
  await execFileAsync("git", ["init", "-q"], { cwd: repo, env: { ...process.env, ...GIT_ENV } });
  const headFiles = head(identity(integrity));
  if (!singleCommit) await commitFiles(repo, { "README.md": "base\n", ...base }, "base");
  await commitFiles(repo, headFiles, "pull request");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "curl"),
    [
      "#!/bin/bash",
      "set -euo pipefail",
      'output=""',
      "while [[ $# -gt 1 ]]; do",
      '  if [[ "$1" == "--output" ]]; then output="$2"; shift; fi',
      "  shift",
      "done",
      'printf "%s\\n" "$1" >>"$CURL_LOG"',
      'cp "$FAKE_NPM_TARBALL" "$output"',
      "",
    ].join("\n"),
  );
  await chmod(join(bin, "curl"), 0o755);
  const runner = join(root, "runner");
  await mkdir(runner);
  const curlLog = join(root, "curl.log");
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${stepScript(STEP_NAME)}`], {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      ...GIT_ENV,
      PATH: `${bin}:${process.env.PATH}`,
      RUNNER_TEMP: runner,
      CURL_LOG: curlLog,
      FAKE_NPM_TARBALL: tarball,
    },
  });
  const fetched = await readFile(curlLog, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, fetched, integrity };
}

const REFUSAL = `::error file=${REQUEST_PATH}::`;

test("verify.yml accepts a request that is exactly what its npm package writes, notes included", async (t) => {
  const run = await runBinding(t, {
    head: (request) => ({ [REQUEST_PATH]: canonical({ ...request, ...NOTES }) }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.fetched, `${TARBALL_URL}\n`);
  assert.equal(run.stderr, "");
});

test("verify.yml keeps a legacy request whose npm package carries no notes", async (t) => {
  const run = await runBinding(t, {
    zergRelease: {},
    head: (request) => ({ [REQUEST_PATH]: canonical(request) }),
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.fetched, `${TARBALL_URL}\n`);
});

test("verify.yml refuses a request whose notes are not its npm package's", async (t) => {
  const typed = await runBinding(t, {
    head: (request) => ({
      [REQUEST_PATH]: canonical({ ...request, whats_new: ["Typed by hand."], changes: NOTES.changes }),
    }),
  });
  assert.equal(typed.status, 1);
  assert.match(typed.stderr, /the request's what's-new notes do not match the npm package's zergRelease/);
  assert.ok(typed.stdout.includes(REFUSAL), typed.stdout);

  // Written with the one-argument mode: the package's notes are missing.
  const dropped = await runBinding(t, {
    head: (request) => ({ [REQUEST_PATH]: canonical(request) }),
  });
  assert.equal(dropped.status, 1);
  assert.ok(dropped.stdout.includes(REFUSAL), dropped.stdout);
  assert.equal(dropped.fetched, `${TARBALL_URL}\n`);

  // The same request in other bytes is not the canonical request.
  const reformatted = await runBinding(t, {
    head: (request) => ({ [REQUEST_PATH]: `${JSON.stringify({ ...request, ...NOTES })}\n` }),
  });
  assert.equal(reformatted.status, 1);
  assert.ok(reformatted.stdout.includes(REFUSAL), reformatted.stdout);
});

test("verify.yml refuses an npm package whose notes break the release-note rules", async (t) => {
  // Even a request without notes cannot be released from such a package.
  const run = await runBinding(t, {
    zergRelease: { whatsNew: ["Thanks @alice for the fix."], changes: [] },
    head: (request) => ({ [REQUEST_PATH]: canonical(request) }),
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /zergRelease\.whatsNew\[0\] must not contain an @mention/);
  assert.ok(run.stdout.includes(REFUSAL), run.stdout);
});

test("verify.yml downloads nothing for a pull request without a request, or an invalid one", async (t) => {
  // An earlier request on the base branch is not this pull request's.
  const unrelated = await runBinding(t, {
    base: { "requests/ztc-desktop-preview-v0.11.0-beta.1.json": "{ not checked here }\n" },
    head: () => ({ "README.md": "changed\n" }),
  });
  assert.equal(unrelated.status, 0, unrelated.stderr);
  assert.equal(unrelated.fetched, "");

  // The URL is used only after the request validates.
  const elsewhere = await runBinding(t, {
    head: (request) => ({
      [REQUEST_PATH]: canonical({
        ...request,
        npm: { ...request.npm, tarballUrl: "https://example.com/ztc-0.12.0-beta.1.tgz" },
      }),
    }),
  });
  assert.notEqual(elsewhere.status, 0);
  assert.match(elsewhere.stderr, /npm artifact URL does not match the exact package version/);
  assert.equal(elsewhere.fetched, "");
});

test("verify.yml fails closed without the pull request's base commit", async (t) => {
  const run = await runBinding(t, {
    singleCommit: true,
    head: (request) => ({ [REQUEST_PATH]: canonical({ ...request, ...NOTES }) }),
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.fetched, "");
});

test("verify.yml binds requests on pull requests, with the base commit fetched", () => {
  assert.match(stepHeader(STEP_NAME), /\n        if: github\.event_name == 'pull_request'\n/);
  assert.match(workflow, /- uses: actions\/checkout@[0-9a-f]{40} # v7\n        with:\n          fetch-depth: 2\n/);
});
