import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { homebrewFormula } from "./public-release.mjs";
const [manifestPath, outputPath] = process.argv.slice(2);
if (!manifestPath || !outputPath || process.argv.length !== 4)
  throw new Error(
    "usage: write-homebrew-formula.mjs VERIFIED_RELEASE.json Formula/ztc.rb",
  );
const formula = homebrewFormula(
  JSON.parse(await readFile(manifestPath, "utf8")),
);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, formula);
