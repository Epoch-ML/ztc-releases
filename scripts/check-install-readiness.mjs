import { readFile } from "node:fs/promises";
import {
  validateZtcPublicRelease,
  homebrewFormula,
} from "./public-release.mjs";
const release = validateZtcPublicRelease(
  JSON.parse(await readFile(process.argv[2], "utf8")),
);
const formula = await readFile(process.argv[3], "utf8");
if (formula !== homebrewFormula(release))
  throw new Error("Homebrew formula does not match the exact verified release");
