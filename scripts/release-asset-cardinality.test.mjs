import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const workflow = await readFile(
  new URL("../.github/workflows/release.yml", import.meta.url), "utf8",
);
const declaredAssets = workflow.match(/          expected_assets=\([\s\S]*?\n          \)/)[0]
  .replace(/^ {10}/gm, "");
const canonicalNames = [
  "ztc.app.tar.gz", "ztc.app.tar.gz.sig", "ztc_1.2.3-preview.1_aarch64.dmg",
  "checksums.txt", "latest.json", "release-metadata.json", "release.json", "release.json.sig",
];

function rejectionGuard(message) {
  const messageAt = workflow.indexOf(message);
  const start = workflow.lastIndexOf("          if [[", messageAt);
  const end = workflow.indexOf("\n          fi", messageAt) + "\n          fi".length;
  return workflow.slice(start, end).replace(/^ {10}/gm, "");
}

const draftCountAt = workflow.indexOf("(.assets | length) ==");
const draftJqStart = workflow.lastIndexOf("          jq -e", draftCountAt);
const draftJqEnd = workflow.indexOf('"$release_json" >/dev/null', draftCountAt)
  + '"$release_json" >/dev/null'.length;
const draftGuard = workflow.slice(draftJqStart, draftJqEnd).replace(/^ {10}/gm, "");
const guards = [
  ["local payload", rejectionGuard("regenerated payload must contain exactly eight canonical assets")],
  ["immutable resume", rejectionGuard("immutable release must contain exactly eight canonical assets")],
  ["verified draft", draftGuard],
  ["published release", rejectionGuard("published release must contain exactly eight canonical assets")],
];

for (const [name, guard] of guards) {
  test(`${name} accepts all eight public assets and rejects missing or extra assets`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "ztc-asset-cardinality-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "payload"));
    const notes = join(root, "notes.md");
    const releaseJson = join(root, "release.json");
    await writeFile(notes, "Qualified fixture\n");
    for (const count of [8, 7, 9]) {
      const names = [...canonicalNames.slice(0, count), ...(count === 9 ? ["unexpected.bin"] : [])];
      await rm(join(root, "payload"), { recursive: true });
      await mkdir(join(root, "payload"));
      for (const asset of names) await writeFile(join(root, "payload", asset), "fixture");
      await writeFile(releaseJson, JSON.stringify({
        tag_name: "ztc-desktop-preview-v1.2.3-preview.1",
        name: "ZTC 1.2.3-preview.1 (preview)", body: "Qualified fixture\n",
        draft: true, immutable: false, prerelease: true,
        assets: names.map((asset) => ({ name: asset })),
      }));
      // Process, filesystem and jq boundaries are real; execute the workflow guard itself.
      const result = spawnSync("bash", ["-c", `set -euo pipefail\n${declaredAssets}\n${guard}\nprintf 'accepted\\n'\n`], {
        cwd: root, encoding: "utf8", env: {
          ...process.env, RELEASE_VERSION: "1.2.3-preview.1", RELEASE_CHANNEL: "preview",
          RELEASE_TAG: "ztc-desktop-preview-v1.2.3-preview.1", release_json: releaseJson,
          notes, expected_prerelease: "true",
        },
      });
      if (count === 8) {
        assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
        assert.match(result.stdout, /accepted/);
      } else {
        assert.equal(result.status, 1, `${name} accepted ${count} assets: ${result.stdout}`);
        assert.doesNotMatch(result.stdout, /accepted/);
      }
    }
  });
}
