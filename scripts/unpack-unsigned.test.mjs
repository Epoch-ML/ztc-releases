import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const script = new URL("./unpack-unsigned.py", import.meta.url).pathname;
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "ztc-unsigned-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    archive: join(root, "bundle.tar.gz"),
    out: join(root, "unpacked"),
  };
}
test("unsigned artifact transfer preserves executable modes and exact binary bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "ztc.app/Contents/MacOS"), { recursive: true });
  const executable = join(f.root, "ztc.app/Contents/MacOS/ZTerm");
  await writeFile(executable, "executable fixture");
  await chmod(executable, 0o755);
  assert.equal(
    spawnSync("tar", ["-czf", f.archive, "-C", f.root, "ztc.app"]).status,
    0,
  );
  const result = spawnSync("python3", [script, f.archive, f.out], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const staged = join(f.out, "ztc.app/Contents/MacOS/ZTerm");
  assert.equal(await readFile(staged, "utf8"), "executable fixture");
  assert.equal((await stat(staged)).mode & 0o777, 0o755);
});
for (const entry of [
  { name: "../escape", type: "file" },
  { name: "ztc.app/link", type: "symlink" },
  { name: "ztc.app/huge", type: "huge" },
])
  test(`unsigned artifact rejects ${entry.type} before creating output`, async (t) => {
    const f = await fixture(t);
    const created = spawnSync(
      "python3",
      [
        "-c",
        `import sys,tarfile,io,json\ne=json.loads(sys.argv[2])\nwith tarfile.open(sys.argv[1], 'w:gz') as tar:\n m=tarfile.TarInfo(e['name'])\n if e['type']=='symlink': m.type=tarfile.SYMTYPE;m.linkname='/tmp'\n elif e['type']=='huge': m.size=1024*1024*1024+1\n if e['type']!='huge': tar.addfile(m,io.BytesIO())\n else: tar.fileobj.write(m.tobuf())\n`,
        f.archive,
        JSON.stringify(entry),
      ],
      { encoding: "utf8" },
    );
    assert.equal(created.status, 0, created.stderr);
    const result = spawnSync("python3", [script, f.archive, f.out], {
      encoding: "utf8",
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unsafe|limit|bound|large/i);
    await assert.rejects(stat(f.out), { code: "ENOENT" });
  });
