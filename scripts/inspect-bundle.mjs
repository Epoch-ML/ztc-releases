import { lstat, readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
export async function inspectBundle(path, version, sourceSha) {
  const root = resolve(path),
    nativeFiles = [];
  let count = 0,
    total = 0;
  if (basename(root) !== "ztc.app") throw new Error("bundle must be ztc.app");
  const walk = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name),
        stat = await lstat(file);
      if (++count > 32768 || (!stat.isDirectory() && !stat.isFile()))
        throw new Error(
          "bundle inventory contains links, special files or too many entries",
        );
      if (entry.name.includes("\n") || entry.name.includes("\r"))
        throw new Error("invalid inventory filename");
      if (stat.isDirectory()) {
        await walk(file);
        continue;
      }
      total += stat.size;
      if (total > 1024 * 1024 * 1024)
        throw new Error("bundle inventory exceeds 1 GiB");
      const data = await readFile(file);
      if (data.length >= 8 && data.readUInt32LE(0) === 0xfeedfacf) {
        if (data.readUInt32LE(4) !== 0x0100000c)
          throw new Error("native payload must be Apple Silicon");
        nativeFiles.push(file);
      } else if (
        data.length >= 4 &&
        [0xfeedface, 0xcafebabe, 0xbebafeca].includes(data.readUInt32LE(0))
      )
        throw new Error("unsupported native payload architecture");
    }
  };
  await walk(root);
  const runtime = JSON.parse(
    await readFile(join(root, "Contents/Resources/ztc-runtime.json"), "utf8"),
  );
  if (
    runtime.schema_version !== 2 ||
    runtime.product !== "ZTC" ||
    runtime.platform !== "darwin-arm64" ||
    runtime.source_sha !== sourceSha ||
    runtime.release_version !== version
  )
    throw new Error("runtime source/release identity mismatch");
  if (
    runtime.node?.version !== "v22.23.2" ||
    runtime.node.executable !== "Resources/runtime/node" ||
    runtime.agent?.entry !== "Resources/runtime/ztc/dist/cli_main.js" ||
    runtime.renderer?.executable !== "MacOS/ZTerm"
  )
    throw new Error("runtime paths or pinned Node do not match");
  const pkg = JSON.parse(
    await readFile(
      join(root, "Contents/Resources/runtime/ztc/package.json"),
      "utf8",
    ),
  );
  if (
    pkg.name !== "@zergai/ztc" ||
    pkg.version !== runtime.agent.version ||
    pkg.zergRelease?.sourceCommit !== sourceSha
  )
    throw new Error("npm artifact/source identity mismatch");
  for (const file of [
    join(root, "Contents/MacOS/ZTerm"),
    join(root, "Contents/Resources/runtime/node"),
  ])
    if (!nativeFiles.includes(file))
      throw new Error("mandatory native payload is absent");
  if ((await readFile(join(root, "Contents/PkgInfo"), "utf8")) !== "APPL????")
    throw new Error("bundle package identity mismatch");
  const plist = await readFile(join(root, "Contents/Info.plist"), "utf8");
  if (
    !/<key>CFBundleIdentifier<\/key>\s*<string>dev\.zerg\.zterm<\/string>/.test(
      plist,
    ) ||
    !/<key>CFBundleDisplayName<\/key>\s*<string>ZTC<\/string>/.test(plist)
  )
    throw new Error("bundle signing/display identity mismatch");
  await readFile(join(root, "Contents/Resources/runtime/ztc/dist/cli_main.js"));
  return {
    nativeFiles: nativeFiles.sort(),
    count,
    total,
    npmVersion: pkg.version,
    runtime,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  inspectBundle(...process.argv.slice(2))
    .then((result) => console.log(result.nativeFiles.join("\n")))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
