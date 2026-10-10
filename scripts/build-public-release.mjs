import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readReleaseRequest } from "./release-request.mjs";
import { validateZtcPublicRelease } from "./public-release.mjs";
const [requestPath, runtimePath, payload] = process.argv.slice(2);
const request = await readReleaseRequest(requestPath);
const bytes = await readFile(runtimePath);
const runtime = JSON.parse(bytes);
const latest = JSON.parse(await readFile(join(payload, "latest.json"), "utf8"));
const metadata = JSON.parse(
  await readFile(join(payload, "release-metadata.json"), "utf8"),
);
if (
  runtime.source_sha !== request.source_sha ||
  runtime.release_version !== request.version ||
  runtime.agent.version !== request.npm.version ||
  metadata.apple_notarized !== true
)
  throw new Error("signed runtime does not match the approved release");
const archive = latest.platforms["darwin-aarch64"];
const dmg = metadata.artifacts.find((a) => a.name.endsWith(".dmg"));
const value = validateZtcPublicRelease({
  schemaVersion: 1,
  product: "ZTC",
  channel: request.channel,
  version: request.version,
  sourceSha: request.source_sha,
  platform: "darwin-arm64",
  publishedAt: request.requested_at,
  npm: request.npm,
  runtime: {
    nodeVersion: "22.23.2",
    manifestSha256: createHash("sha256").update(bytes).digest("hex"),
  },
  assets: {
    archive: {
      url: archive.url,
      sha256: archive.sha256,
      signature: archive.signature,
    },
    dmg: {
      url: `https://github.com/Epoch-ML/ztc-releases/releases/download/${request.release_tag}/${dmg.name}`,
      sha256: dmg.sha256,
    },
  },
  bundle: { identifier: "dev.zerg.zterm", appName: "ztc.app" },
  trust: {
    updaterKeyId: request.channel,
    appleTeamId: "JLNC3N65LF",
    notarized: true,
  },
});
await writeFile(
  join(payload, "release.json"),
  `${JSON.stringify(value, null, 2)}\n`,
);
