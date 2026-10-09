// Public ZTC distribution contract. No signing credentials are read here.
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;
const HEX = /^[0-9a-f]{64}$/;
function requireValue(condition, message) {
  if (!condition) throw new Error(`ZTC release: ${message}`);
}
function record(value, keys, name) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${name} must be an object`,
  );
  requireValue(
    Object.keys(value).length === keys.length &&
      keys.every((key) => Object.hasOwn(value, key)),
    `${name} fields do not match the public contract`,
  );
}
function version(value) {
  requireValue(
    typeof value === "string" && SEMVER.test(value),
    "version must be strict SemVer",
  );
}
function timestamp(value) {
  requireValue(
    typeof value === "string" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString() === value,
    "timestamp must be canonical UTC",
  );
}
function channelVersion(channel, value) {
  requireValue(
    channel === "stable" || channel === "preview",
    "channel must be stable or preview",
  );
  version(value);
  requireValue(
    channel !== "stable" || !value.includes("-"),
    "stable version cannot be a prerelease",
  );
}
export function ztcReleaseTag(channel, version) {
  return `ztc-desktop-${channel === "preview" ? "preview-" : ""}v${version}`;
}
export function validateNpmIdentity(npm) {
  record(npm, ["name", "version", "integrity", "tarballUrl"], "npm");
  version(npm.version);
  requireValue(npm.name === "@zergai/ztc", "npm package must be @zergai/ztc");
  requireValue(
    typeof npm.integrity === "string" &&
      /^sha512-[A-Za-z0-9+/]{86}==$/.test(npm.integrity),
    "npm integrity must be SHA512",
  );
  requireValue(
    npm.tarballUrl ===
      `https://registry.npmjs.org/@zergai/ztc/-/ztc-${npm.version}.tgz`,
    "npm artifact URL does not match the exact package version",
  );
  return structuredClone(npm);
}
export function makeZtcReleaseRequest(options) {
  channelVersion(options.channel, options.version);
  timestamp(options.requestedAt);
  requireValue(
    typeof options.sourceSha === "string" &&
      /^[0-9a-f]{40}$/.test(options.sourceSha),
    "source SHA must be exactly 40 lowercase hex characters",
  );
  const tag = ztcReleaseTag(options.channel, options.version);
  requireValue(
    options.sourceRef === `refs/tags/${tag}`,
    "source ref does not match the release tag",
  );
  const npm = validateNpmIdentity(options.npm);
  requireValue(
    options.channel !== "stable" || !npm.version.includes("-"),
    "stable release cannot embed a prerelease npm package",
  );
  return {
    schema_version: 1,
    product: "ZTC",
    channel: options.channel,
    version: options.version,
    release_tag: tag,
    source_repository: "Epoch-ML/zerg",
    source_sha: options.sourceSha,
    source_ref: options.sourceRef,
    requested_at: options.requestedAt,
    npm,
  };
}
export function validateZtcPublicRelease(value) {
  record(
    value,
    [
      "schemaVersion",
      "product",
      "channel",
      "version",
      "sourceSha",
      "platform",
      "publishedAt",
      "npm",
      "runtime",
      "assets",
      "bundle",
      "trust",
    ],
    "release",
  );
  requireValue(
    value.schemaVersion === 1 &&
      value.product === "ZTC" &&
      value.platform === "darwin-arm64",
    "unsupported release schema/product/platform",
  );
  channelVersion(value.channel, value.version);
  timestamp(value.publishedAt);
  requireValue(
    typeof value.sourceSha === "string" &&
      /^[0-9a-f]{40}$/.test(value.sourceSha),
    "invalid source SHA",
  );
  validateNpmIdentity(value.npm);
  requireValue(
    value.channel !== "stable" || !value.npm.version.includes("-"),
    "stable release cannot embed a prerelease npm package",
  );
  record(value.runtime, ["nodeVersion", "manifestSha256"], "runtime");
  requireValue(
    value.runtime.nodeVersion === "22.23.2",
    "Node version must be 22.23.2",
  );
  requireValue(
    HEX.test(value.runtime.manifestSha256),
    "invalid runtime checksum",
  );
  record(value.bundle, ["identifier", "appName"], "bundle");
  requireValue(
    value.bundle.identifier === "dev.zerg.zterm" &&
      value.bundle.appName === "ztc.app",
    "bundle identity mismatch",
  );
  record(value.trust, ["updaterKeyId", "appleTeamId", "notarized"], "trust");
  requireValue(
    value.trust.updaterKeyId === value.channel &&
      value.trust.appleTeamId === "JLNC3N65LF" &&
      value.trust.notarized === true,
    "release must be notarized by the pinned team and signed for this channel",
  );
  record(value.assets, ["archive", "dmg"], "assets");
  record(value.assets.archive, ["url", "sha256", "signature"], "archive");
  record(value.assets.dmg, ["url", "sha256"], "dmg");
  const base = `https://github.com/Epoch-ML/ztc-releases/releases/download/${ztcReleaseTag(value.channel, value.version)}`;
  requireValue(
    value.assets.archive.url === `${base}/ztc.app.tar.gz` &&
      value.assets.dmg.url === `${base}/ztc_${value.version}_aarch64.dmg`,
    "artifact URLs must match the exact release",
  );
  for (const asset of Object.values(value.assets))
    requireValue(HEX.test(asset.sha256), "invalid artifact checksum");
  requireValue(
    typeof value.assets.archive.signature === "string" &&
      value.assets.archive.signature.trim().length > 0 &&
      value.assets.archive.signature.length <= 8192,
    "invalid archive signature",
  );
  requireValue(
    Buffer.byteLength(JSON.stringify(value)) <= 262144,
    "release exceeds 256 KiB",
  );
  return structuredClone(value);
}
export function homebrewFormula(release) {
  const value = validateZtcPublicRelease(release);
  return `class Ztc < Formula\n  desc "ZTC coding agent with its self-contained desktop runtime"\n  homepage "https://zergai.com/ztc"\n  url "${value.assets.archive.url}"\n  version "${value.npm.version}"\n  sha256 "${value.assets.archive.sha256}"\n  depends_on :macos\n  depends_on arch: :arm64\n\n  def install\n    app = buildpath/"ztc.app"
    app = buildpath unless app.directory?
    (libexec/"ztc.app").install app.children\n    (bin/"ztc").write <<~SH\n      #!/bin/sh\n      exec '#{libexec}/ztc.app/Contents/MacOS/ZTerm' --ztc-cli "$@"\n    SH\n  end\n\n  def caveats\n    "Open #{libexec}/ztc.app for the desktop. Existing ~/.ztc profiles are shared."\n  end\n\n  test do\n    assert_match version.to_s, shell_output("#{bin}/ztc --version")\n  end\nend\n`;
}
