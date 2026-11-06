import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { latestChanges, latestNotes, releaseBody } from "./release-notes.mjs";
import { readReleaseRequest } from "./release-request.mjs";

const execFileAsync = promisify(execFile);
const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const REQUESTS = fileURLToPath(new URL("../requests/", import.meta.url));
// The release text the lane (Epoch-ML/zerg whats-new.mjs body and feed) must
// produce too: it carries this file byte for byte. Change it in both.
const RELEASE_TEXT_BYTES = await readFile(new URL("./fixtures/release-text-fixture.json", import.meta.url));
const RELEASE_TEXT = JSON.parse(RELEASE_TEXT_BYTES.toString("utf8"));
const RELEASE_TEXT_SHA256 = "94870f88b7d2b996425b3f748a6ec262bf31d9e0db20d0870268053d4d83de72";
const workflows = {
  "release.yml": await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
  "activate.yml": await readFile(new URL("../.github/workflows/activate.yml", import.meta.url), "utf8"),
};

// Bytes of every release published before what's-new notes: their GitHub
// Release bodies and latest.json notes are immutable, and re-activating one
// must reproduce them exactly.
const PUBLISHED = new Map([
  [
    "ztc-desktop-preview-v0.5.0-beta.1",
    {
      notes: "ZTC preview release from source 639a0d0cc4d6e3eed77db19d937862ab82a36f22.",
      body: "ZTC 0.5.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `639a0d0cc4d6e3eed77db19d937862ab82a36f22`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
  [
    "ztc-desktop-preview-v0.7.0-beta.1",
    {
      notes: "ZTC preview release from source fbac9c4b9709a604200a4865467591b4d31dbcf3.",
      body: "ZTC 0.7.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `fbac9c4b9709a604200a4865467591b4d31dbcf3`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
  [
    "ztc-desktop-preview-v0.8.0-beta.1",
    {
      notes: "ZTC preview release from source 25bc5f194ad47cb6534776d9433e6619a8438bcf.",
      body: "ZTC 0.8.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `25bc5f194ad47cb6534776d9433e6619a8438bcf`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
  [
    "ztc-desktop-preview-v0.9.0-beta.1",
    {
      notes: "ZTC preview release from source eac530d341d6b7057b5fcc242ce3d9c835ceeeb1.",
      body: "ZTC 0.9.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `eac530d341d6b7057b5fcc242ce3d9c835ceeeb1`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
  [
    "ztc-desktop-preview-v0.10.0-beta.1",
    {
      notes: "ZTC preview release from source f987bf5a7f5b3b8c9b6ed6e5ace077242bdb2be6.",
      body: "ZTC 0.10.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `f987bf5a7f5b3b8c9b6ed6e5ace077242bdb2be6`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
  [
    "ztc-desktop-preview-v0.11.0-beta.1",
    {
      notes: "ZTC preview release from source eedc94d57cd6224856beab9b16b5d6c235978ece.",
      body: "ZTC 0.11.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `eedc94d57cd6224856beab9b16b5d6c235978ece`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.",
    },
  ],
]);

const IDENTITY = {
  schema_version: 1,
  product: "ZTC",
  channel: "preview",
  version: "0.12.0-beta.1",
  release_tag: "ztc-desktop-preview-v0.12.0-beta.1",
  source_repository: "Epoch-ML/zerg",
  source_sha: "1234567890abcdef1234567890abcdef12345678",
  source_ref: "refs/tags/ztc-desktop-preview-v0.12.0-beta.1",
  requested_at: "2026-11-12T18:00:00.000Z",
  npm: {
    name: "@zergai/ztc",
    version: "0.12.0-beta.1",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarballUrl: "https://registry.npmjs.org/@zergai/ztc/-/ztc-0.12.0-beta.1.tgz",
  },
};
const IDENTITY_BODY =
  "ZTC 0.12.0-beta.1 (preview).\n\nBuilt from immutable Epoch-ML/zerg source commit `1234567890abcdef1234567890abcdef12345678`.\n\nThe updater archive is signed independently from the macOS application signature.\n\nBridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.";
const IDENTITY_NOTES =
  "ZTC preview release from source 1234567890abcdef1234567890abcdef12345678.";
const NOTED = {
  ...IDENTITY,
  whats_new: ["Panes keep the name you give them.", "Resumed sessions draw at once."],
  changes: [
    "A renamed pane keeps its name in the desktop app.",
    "Session resume no longer spends seconds before drawing.",
    "ztc update installs a release published minutes earlier.",
  ],
};
const NOTED_NOTES = "• Panes keep the name you give them.\n• Resumed sessions draw at once.";
const NOTED_BODY = `${IDENTITY_BODY}\n\nWhat's new:\n- Panes keep the name you give them.\n- Resumed sessions draw at once.\n\nAll changes:\n- A renamed pane keeps its name in the desktop app.\n- Session resume no longer spends seconds before drawing.\n- ztc update installs a release published minutes earlier.`;

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "ztc-release-notes-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function writeRequest(directory, request, name = `${request.release_tag}.json`) {
  const path = join(directory, name);
  await writeFile(path, `${JSON.stringify(request, null, 2)}\n`);
  return path;
}

// jq is a process boundary: the workflows run this same filter file.
async function jqRelease(requestPath, expression, output = "-j") {
  const { stdout } = await execFileAsync("jq", [
    output,
    "-L",
    SCRIPTS,
    `include "release-notes"; ${expression}`,
    requestPath,
  ]);
  return stdout;
}

async function derivedByJq(requestPath) {
  return {
    body: await jqRelease(requestPath, "release_body"),
    notes: await jqRelease(requestPath, "latest_notes"),
    changes: JSON.parse(await jqRelease(requestPath, "latest_changes", "-c")),
  };
}

function derivedByVerifier(request) {
  const changes = latestChanges(request);
  return {
    body: releaseBody(request),
    notes: latestNotes(request),
    changes: changes === null ? {} : { changes },
  };
}

test("every committed request reproduces its published release body and updater notes", async () => {
  const names = (await readdir(REQUESTS)).filter((name) => name.endsWith(".json")).sort();
  for (const tag of PUBLISHED.keys()) {
    assert.ok(names.includes(`${tag}.json`), `${tag} must stay committed`);
  }
  for (const name of names) {
    const path = join(REQUESTS, name);
    const request = await readReleaseRequest(path);
    const byJq = await derivedByJq(path);
    assert.deepEqual(byJq, derivedByVerifier(request), `${name}: workflows and verifier differ`);
    const published = PUBLISHED.get(request.release_tag);
    if (published !== undefined) {
      assert.deepEqual(byJq, { body: published.body, notes: published.notes, changes: {} }, name);
    }
  }
});

test("a noted request gives the updater bullet lines and the release page both lists", async (t) => {
  const directory = await temporaryDirectory(t);
  const path = await writeRequest(directory, NOTED);
  assert.deepEqual(await readReleaseRequest(path), NOTED);
  const expected = { body: NOTED_BODY, notes: NOTED_NOTES, changes: { changes: NOTED.changes } };
  assert.deepEqual(await derivedByJq(path), expected);
  assert.deepEqual(derivedByVerifier(NOTED), expected);
});

test("a noted request without changes has neither a changes key nor an All changes section", async (t) => {
  const directory = await temporaryDirectory(t);
  const request = { ...NOTED, whats_new: ["Fixes and improvements."], changes: [] };
  const path = await writeRequest(directory, request);
  assert.deepEqual(await readReleaseRequest(path), request);
  const expected = {
    body: `${IDENTITY_BODY}\n\nWhat's new:\n- Fixes and improvements.`,
    notes: "• Fixes and improvements.",
    changes: {},
  };
  assert.deepEqual(await derivedByJq(path), expected);
  assert.deepEqual(derivedByVerifier(request), expected);
});

test("jq and the verifier agree byte for byte on escaped, non-ASCII, quoted and backslashed text", async (t) => {
  const directory = await temporaryDirectory(t);
  const request = {
    ...IDENTITY,
    whats_new: [
      "Café menus show naïve “smart quotes” — and 😀 emoji.",
      "日本語のメニューが表示されます。",
    ],
    changes: ["Backslash \\ and \"quotes\" survive.", "Ellipsis is one character…"],
  };
  // The workflows read the committed bytes, the verifier their parsed form:
  // write reordered keys with every non-ASCII character as a JSON escape.
  const reordered = Object.fromEntries(Object.entries(request).reverse());
  const escaped = JSON.stringify(reordered).replace(
    /[\u007f-￿]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  const path = join(directory, "escaped.json");
  await writeFile(path, escaped);
  assert.deepEqual(await readReleaseRequest(path), request);
  const expected = {
    body: `${IDENTITY_BODY}\n\nWhat's new:\n- Café menus show naïve “smart quotes” — and 😀 emoji.\n- 日本語のメニューが表示されます。\n\nAll changes:\n- Backslash \\ and "quotes" survive.\n- Ellipsis is one character…`,
    notes: "• Café menus show naïve “smart quotes” — and 😀 emoji.\n• 日本語のメニューが表示されます。",
    changes: { changes: ["Backslash \\ and \"quotes\" survive.", "Ellipsis is one character…"] },
  };
  assert.deepEqual(await derivedByJq(path), expected);
  assert.deepEqual(derivedByVerifier(request), expected);
});

function bodySteps(workflow) {
  const steps = [];
  const marker = '\n          notes="$RUNNER_TEMP/';
  for (let start = workflow.indexOf(marker); start >= 0; start = workflow.indexOf(marker, start + 1)) {
    const end = workflow.indexOf('>"$notes"\n', start) + '>"$notes"'.length;
    steps.push(workflow.slice(start + 1, end).replace(/^ {10}/gm, ""));
  }
  return steps;
}

async function runStep(t, step, request, indexDirectory, env = {}) {
  const root = await temporaryDirectory(t);
  await mkdir(join(root, indexDirectory, "scripts"), { recursive: true });
  await mkdir(join(root, indexDirectory, "requests"), { recursive: true });
  await mkdir(join(root, "payload"));
  await mkdir(join(root, "runner"));
  await copyFile(join(SCRIPTS, "release-notes.jq"), join(root, indexDirectory, "scripts", "release-notes.jq"));
  await writeRequest(join(root, indexDirectory, "requests"), request);
  // bash, jq and the filesystem are real; the workflow's own step text runs.
  const result = spawnSync("bash", ["-c", `set -euo pipefail\n${step}`], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      RELEASE_CHANNEL: request.channel,
      RELEASE_TAG: request.release_tag,
      RELEASE_VERSION: request.version,
      SOURCE_SHA: request.source_sha,
      RUNNER_TEMP: join(root, "runner"),
      ...env,
    },
  });
  return { root, result };
}

test("every release body step in release.yml and activate.yml derives the body from the request", async (t) => {
  for (const [name, expectedSteps] of [["release.yml", 3], ["activate.yml", 1]]) {
    const steps = bodySteps(workflows[name]);
    assert.equal(steps.length, expectedSteps, `${name} body steps`);
    for (const step of steps) {
      for (const [request, body] of [[IDENTITY, IDENTITY_BODY], [NOTED, NOTED_BODY]]) {
        const { result } = await runStep(t, `${step}\ncat -- "$notes"`, request, "index");
        assert.equal(result.status, 0, `${name}: ${result.stderr}`);
        assert.equal(result.stdout, body, `${name}: ${step.split("\n")[0]}`);
      }
    }
  }
});

test("the signed payload's latest.json takes its notes and changes only from the request", async (t) => {
  const workflow = workflows["release.yml"];
  assert.equal(workflow.split(">payload/latest.json").length - 1, 1);
  const end = workflow.indexOf(">payload/latest.json") + ">payload/latest.json".length;
  const builder = workflow
    .slice(workflow.lastIndexOf("\n          jq", end) + 1, end)
    .replace(/^ {10}/gm, "");
  const platforms = {
    "darwin-aarch64": {
      sha256: "c".repeat(64),
      signature: "c2lnbmF0dXJl",
      url: "https://github.com/Epoch-ML/ztc-releases/releases/download/ztc-desktop-preview-v0.12.0-beta.1/ztc.app.tar.gz",
    },
  };
  const manifests = [
    [IDENTITY, {
      schema_version: 1, product: "ZTC", version: "0.12.0-beta.1", notes: IDENTITY_NOTES,
      pub_date: "2026-11-12T18:00:00.000Z", platforms,
    }],
    [NOTED, {
      schema_version: 1, product: "ZTC", version: "0.12.0-beta.1", notes: NOTED_NOTES,
      changes: NOTED.changes, pub_date: "2026-11-12T18:00:00.000Z", platforms,
    }],
    [{ ...NOTED, changes: [] }, {
      schema_version: 1, product: "ZTC", version: "0.12.0-beta.1", notes: NOTED_NOTES,
      pub_date: "2026-11-12T18:00:00.000Z", platforms,
    }],
  ];
  for (const [request, expected] of manifests) {
    const { root, result } = await runStep(t, builder, request, "release-index", {
      archive_sha: platforms["darwin-aarch64"].sha256,
      archive_url: platforms["darwin-aarch64"].url,
      signature: platforms["darwin-aarch64"].signature,
      RELEASE_DATE: request.requested_at,
    });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(await readFile(join(root, "payload", "latest.json"), "utf8"));
    assert.deepEqual(manifest, expected);
    assert.deepEqual(Object.keys(manifest), Object.keys(expected));
  }
});

test("workflows type no release text and bind every bundle's notes to the request", () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const typed of [
      "release from source",
      "Built from immutable Epoch-ML/zerg source commit",
      "Bridge notice:",
    ]) {
      assert.equal(workflow.includes(typed), false, `${name} must not type "${typed}"`);
    }
  }
  const inspections = (workflow) =>
    workflow
      .split("\n")
      .filter((line) => line.includes("inspect-bundle.mjs"))
      .map((line) => line.trim());
  assert.deepEqual(inspections(workflows["release.yml"]), [
    'node scripts/inspect-bundle.mjs "$app" "$RELEASE_VERSION" "$SOURCE_SHA" "requests/$RELEASE_TAG.json" > "$RUNNER_TEMP/native-payloads.txt"',
    'node index/scripts/inspect-bundle.mjs "$extract_dir/ztc.app" "$RELEASE_VERSION" "$SOURCE_SHA" "index/requests/${RELEASE_TAG}.json" > /dev/null',
  ]);
  assert.deepEqual(inspections(workflows["activate.yml"]), [
    'node index/scripts/inspect-bundle.mjs "$extract_dir/ztc.app" "$RELEASE_VERSION" "$SOURCE_SHA" "index/requests/${RELEASE_TAG}.json" > /dev/null',
  ]);
});

test("release-notes.jq and release-notes.mjs write every case of the shared release text", async (t) => {
  assert.equal(createHash("sha256").update(RELEASE_TEXT_BYTES).digest("hex"), RELEASE_TEXT_SHA256);
  assert.equal(RELEASE_TEXT.text_version, 1);
  assert.equal(RELEASE_TEXT.cases.length, 6);
  const directory = await temporaryDirectory(t);
  for (const { name, request, release_body, latest } of RELEASE_TEXT.cases) {
    const path = await writeRequest(directory, request);
    assert.deepEqual(await readReleaseRequest(path), request, `${name}: the request must be valid`);
    const expected = { body: release_body, latest };
    const byJq = {
      body: await jqRelease(path, "release_body"),
      latest: JSON.parse(await jqRelease(path, "{notes: latest_notes} + latest_changes", "-c")),
    };
    assert.deepEqual(byJq, expected, `${name}: release-notes.jq`);
    assert.deepEqual(Object.keys(byJq.latest), Object.keys(latest), `${name}: latest.json key order`);
    const changes = latestChanges(request);
    const byVerifier = {
      body: releaseBody(request),
      latest: { notes: latestNotes(request), ...(changes === null ? {} : { changes }) },
    };
    assert.deepEqual(byVerifier, expected, `${name}: release-notes.mjs`);
  }
});

test("every body and latest.json step of the workflows writes the shared release text", async (t) => {
  const end = workflows["release.yml"].indexOf(">payload/latest.json") + ">payload/latest.json".length;
  const builder = workflows["release.yml"]
    .slice(workflows["release.yml"].lastIndexOf("\n          jq", end) + 1, end)
    .replace(/^ {10}/gm, "");
  const steps = [...bodySteps(workflows["release.yml"]), ...bodySteps(workflows["activate.yml"])];
  assert.equal(steps.length, 4);
  for (const { name, request, release_body, latest } of RELEASE_TEXT.cases) {
    for (const step of steps) {
      const { result } = await runStep(t, `${step}\ncat -- "$notes"`, request, "index");
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(result.stdout, release_body, `${name}: ${step.split("\n")[0]}`);
    }
    const { root, result } = await runStep(t, builder, request, "release-index", {
      archive_sha: "c".repeat(64),
      archive_url: `https://github.com/Epoch-ML/ztc-releases/releases/download/${request.release_tag}/ztc.app.tar.gz`,
      signature: "c2lnbmF0dXJl",
      RELEASE_DATE: request.requested_at,
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    const manifest = JSON.parse(await readFile(join(root, "payload", "latest.json"), "utf8"));
    const written = { notes: manifest.notes, ...(Object.hasOwn(manifest, "changes") ? { changes: manifest.changes } : {}) };
    assert.deepEqual(written, latest, `${name}: latest.json`);
  }
});
