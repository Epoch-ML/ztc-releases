import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("formula installs only signed bundle contents when Homebrew unwraps the archive", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ztc-formula-staging-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const build = join(directory, "build");
  const prefix = join(directory, "prefix");
  await mkdir(join(build, "Contents"), { recursive: true });
  await writeFile(join(build, "Contents", "Info.plist"), "signed bundle identity");
  await mkdir(join(build, ".brew_home"));
  await writeFile(join(build, ".brew_home", "config"), "Homebrew staging state");
  await mkdir(join(prefix, "libexec"), { recursive: true });
  await mkdir(join(prefix, "bin"));
  const path = join(directory, "ztc.rb");
  await writeFile(path, homebrewFormula(release()));
  // Homebrew is an external process boundary; its filesystem install primitive
  // is represented here while the generated Ruby and filesystem remain real.
  const runner = `
require "fileutils"
require "pathname"
class Formula
  [:desc, :homepage, :url, :version, :sha256, :depends_on].each do |name|
    define_singleton_method(name) { |*arguments| }
  end
  def self.test(&block); end
  attr_accessor :buildpath, :libexec, :bin
end
class Pathname
  def install(*sources)
    FileUtils.mkdir_p(self)
    sources.flatten.each do |source|
      FileUtils.cp_r(source, self/source.basename)
    end
  end
end
load ARGV[0]
formula = Ztc.new
formula.buildpath = Pathname.new(ARGV[1])
formula.libexec = Pathname.new(ARGV[2])/"libexec"
formula.bin = Pathname.new(ARGV[2])/"bin"
formula.install
`;
  const result = spawnSync("ruby", ["-e", runner, path, build, prefix], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readdir(join(prefix, "libexec", "ztc.app")), ["Contents"]);
  assert.equal(await readFile(join(prefix, "libexec", "ztc.app", "Contents", "Info.plist"), "utf8"), "signed bundle identity");
  assert.match(await readFile(join(prefix, "bin", "ztc"), "utf8"), /--ztc-cli "\$@"/);
});
