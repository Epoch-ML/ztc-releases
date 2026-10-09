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
