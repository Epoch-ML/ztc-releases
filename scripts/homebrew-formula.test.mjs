import assert from "node:assert/strict";
import test from "node:test";

import { homebrewFormula } from "./public-release.mjs";

function release() {
  const base = "https://github.com/Epoch-ML/ztc-releases/releases/download/ztc-desktop-preview-v0.5.0-beta.1";
  return {
    schemaVersion: 1,
    product: "ZTC",
    channel: "preview",
    version: "0.5.0-beta.1",
    sourceSha: "a".repeat(40),
    platform: "darwin-arm64",
    publishedAt: "2026-10-10T04:09:08.161Z",
    npm: {
      name: "@zergai/ztc",
      version: "0.5.0-beta.1",
      integrity: "sha512-" + Buffer.alloc(64).toString("base64"),
      tarballUrl: "https://registry.npmjs.org/@zergai/ztc/-/ztc-0.5.0-beta.1.tgz",
    },
    runtime: { nodeVersion: "22.23.2", manifestSha256: "b".repeat(64) },
    assets: {
      archive: { url: `${base}/ztc.app.tar.gz`, sha256: "c".repeat(64), signature: "signature" },
      dmg: { url: `${base}/ztc_0.5.0-beta.1_aarch64.dmg`, sha256: "d".repeat(64) },
    },
    bundle: { identifier: "dev.zerg.zterm", appName: "ztc.app" },
    trust: { updaterKeyId: "preview", appleTeamId: "JLNC3N65LF", notarized: true },
  };
}

test("formula description satisfies Homebrew's no-leading-name rule", () => {
  const value = release();
  const formula = homebrewFormula(value);
  assert.match(formula, /\n  desc "Coding agent with its self-contained desktop runtime"\n/);
  assert.match(formula, new RegExp(`sha256 "${value.assets.archive.sha256}"`));
  assert.ok(formula.includes(`url "${value.assets.archive.url}"`));
});

test("formula orders architecture before operating-system requirements", () => {
  const formula = homebrewFormula(release());
  assert.match(formula, /\n  depends_on arch: :arm64\n  depends_on :macos\n/);
  assert.match(formula, /--ztc-cli "\$@"/);
  assert.match(formula, /assert_match version\.to_s, shell_output\("#\{bin\}\/ztc --version"\)/);
});

test("formula rejects an archive outside the exact signed release", () => {
  const value = release();
  value.assets.archive.url = value.assets.archive.url.replace("ztc-releases", "other-releases");
  assert.throws(() => homebrewFormula(value), {
    name: "Error",
    message: "ZTC release: artifact URLs must match the exact release",
  });
});
