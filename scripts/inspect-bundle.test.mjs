import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectBundle } from "./inspect-bundle.mjs";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "ztc-inventory-")),
    app = join(root, "ztc.app");
  await mkdir(join(app, "Contents/MacOS"), { recursive: true });
  await mkdir(join(app, "Contents/Resources/runtime/ztc/dist"), {
    recursive: true,
  });
  const macho = Buffer.from(
    "cffaedfe0c000001000000000200000000000000000000000000000000000000",
    "hex",
  );
  for (const p of ["Contents/MacOS/ZTerm", "Contents/Resources/runtime/node"])
    await writeFile(join(app, p), macho);
  await writeFile(join(app, "Contents/PkgInfo"), "APPL????");
  await writeFile(
    join(app, "Contents/Info.plist"),
    "<key>CFBundleIdentifier</key>\n<string>dev.zerg.zterm</string>\n<key>CFBundleDisplayName</key>\n<string>ZTC</string>",
  );
  await writeFile(
    join(app, "Contents/Resources/runtime/ztc/dist/cli_main.js"),
    "agent",
  );
  await writeFile(
    join(app, "Contents/Resources/runtime/ztc/package.json"),
    JSON.stringify({
      name: "@zergai/ztc",
      version: "0.4.0-beta.2",
      zergRelease: { sourceCommit: "a".repeat(40) },
    }),
  );
  await writeFile(
    join(app, "Contents/Resources/ztc-runtime.json"),
    JSON.stringify({
      schema_version: 2,
      product: "ZTC",
      platform: "darwin-arm64",
      source_sha: "a".repeat(40),
      release_version: "0.4.0-beta.2",
      node: { version: "v22.23.2", executable: "Resources/runtime/node" },
      agent: {
        version: "0.4.0-beta.2",
        entry: "Resources/runtime/ztc/dist/cli_main.js",
      },
      renderer: { executable: "MacOS/ZTerm" },
    }),
  );
  return { root, app };
}
test("bounded bundle inspection returns every native payload without executing it", async () => {
  const f = await fixture();
  try {
    const r = await inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40));
    assert.deepEqual(
      r.nativeFiles.sort(),
      [
        join(f.app, "Contents/MacOS/ZTerm"),
        join(f.app, "Contents/Resources/runtime/node"),
      ].sort(),
    );
    assert.equal(r.npmVersion, "0.4.0-beta.2");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("bundle inspection refuses links and source mismatches", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "b".repeat(40)),
      /source|inventory/,
    );
    await symlink("/tmp", join(f.app, "Contents/Resources/escape"));
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40)),
      /link|inventory/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("bundle inspection refuses an x86 native runtime before signing", async () => {
  const f = await fixture();
  try {
    const x86 = Buffer.from(
      "cffaedfe07000001000000000200000000000000000000000000000000000000",
      "hex",
    );
    await writeFile(join(f.app, "Contents/Resources/runtime/node"), x86);
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40)),
      /Apple Silicon/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("bundle inspection rejects a manifest claiming a different source than the packaged agent", async () => {
  const f = await fixture();
  try {
    const path = join(f.app, "Contents/Resources/ztc-runtime.json");
    const runtime = JSON.parse(
      await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")),
    );
    runtime.source_sha = "b".repeat(40);
    await writeFile(path, JSON.stringify(runtime));
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40)),
      /runtime source\/release identity mismatch/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

function message(expected) {
  return (error) => {
    assert.equal(error.message, expected);
    return true;
  };
}

const WHATS_NEW = ["Panes keep the name you give them.", "Resumed sessions draw at once."];
const CHANGES = ["A renamed pane keeps its name in the desktop app."];

async function stampPackage(app, release) {
  await writeFile(
    join(app, "Contents/Resources/runtime/ztc/package.json"),
    JSON.stringify({
      name: "@zergai/ztc",
      version: "0.4.0-beta.2",
      zergRelease: { sourceCommit: "a".repeat(40), ...release },
    }),
  );
}

async function writeRequest(root, fields = {}) {
  const path = join(root, "request.json");
  await writeFile(
    path,
    JSON.stringify({
      schema_version: 1,
      product: "ZTC",
      channel: "preview",
      version: "0.4.0-beta.2",
      release_tag: "ztc-desktop-preview-v0.4.0-beta.2",
      source_repository: "Epoch-ML/zerg",
      source_sha: "a".repeat(40),
      source_ref: "refs/tags/ztc-desktop-preview-v0.4.0-beta.2",
      requested_at: "2026-11-05T22:12:46.000Z",
      npm: {
        name: "@zergai/ztc",
        version: "0.4.0-beta.2",
        integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
        tarballUrl: "https://registry.npmjs.org/@zergai/ztc/-/ztc-0.4.0-beta.2.tgz",
      },
      ...fields,
    }),
  );
  return path;
}

test("bundle inspection binds the packaged agent's what's-new notes to the release request", async () => {
  const f = await fixture();
  try {
    await stampPackage(f.app, { whatsNew: WHATS_NEW, changes: CHANGES });
    const matching = await writeRequest(f.root, { whats_new: WHATS_NEW, changes: CHANGES });
    const result = await inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), matching);
    assert.equal(result.npmVersion, "0.4.0-beta.2");

    for (const fields of [
      { whats_new: ["Typed by hand."], changes: CHANGES },
      { whats_new: WHATS_NEW, changes: [] },
      {},
    ]) {
      const request = await writeRequest(f.root, fields);
      await assert.rejects(
        inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), request),
        message("the request's what's-new notes do not match the npm package's zergRelease"),
      );
    }
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("bundle inspection keeps releases without notes valid only against requests without notes", async () => {
  const f = await fixture();
  try {
    const legacy = await writeRequest(f.root);
    const result = await inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), legacy);
    assert.equal(result.runtime.release_version, "0.4.0-beta.2");

    const noted = await writeRequest(f.root, { whats_new: WHATS_NEW, changes: CHANGES });
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), noted),
      message("the request's what's-new notes do not match the npm package's zergRelease"),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("bundle inspection refuses a request for another release than the bundle", async () => {
  const f = await fixture();
  try {
    const other = await writeRequest(f.root, {
      version: "0.4.0-beta.3",
      release_tag: "ztc-desktop-preview-v0.4.0-beta.3",
      source_ref: "refs/tags/ztc-desktop-preview-v0.4.0-beta.3",
    });
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), other),
      message("release request does not match the bundle's release version and source"),
    );
    const otherSource = await writeRequest(f.root, { source_sha: "b".repeat(40) });
    await assert.rejects(
      inspectBundle(f.app, "0.4.0-beta.2", "a".repeat(40), otherSource),
      message("release request does not match the bundle's release version and source"),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
