#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateNpmIdentity } from "./public-release.mjs";

const EXPECTED_FIELDS = [
  "channel",
  "product",
  "release_tag",
  "requested_at",
  "schema_version",
  "source_ref",
  "source_repository",
  "source_sha",
  "version",
  "npm",
];
// What's-new notes copied from the npm package's zergRelease: both or neither.
const NOTE_FIELDS = ["whats_new", "changes"];
// Holds the longest notes the limits below allow (about 51 KB of UTF-8).
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_NPM_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;

// The release-note rules, rules_version 1 of fixtures/release-notes-fixture.json.
// The lane (Epoch-ML/zerg) enforces the same rules with validateReleaseNotes
// before npm publish, and both repositories run every case of that file, so an
// npm version can never carry notes this publisher refuses.
const WHATS_NEW_LIMITS = { minimum: 1, maximum: 4, codePoints: 140 };
const CHANGES_LIMITS = { minimum: 0, maximum: 40, codePoints: 300 };
// Controls (tabs and line breaks too), lone surrogates, private-use characters,
// line and paragraph separators, and format characters such as bidi overrides,
// zero-width spaces, soft hyphens and byte order marks. U+200C and U+200D stay:
// emoji sequences and Persian or Indic text need them.
const FORBIDDEN_CHARACTER =
  /[\p{Cc}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|(?![\u200c\u200d])\p{Cf}/u;
const CHARACTER_KINDS = [
  [/\p{Cc}/u, "a control character"],
  [/\p{Cf}/u, "a format character"],
  [/\p{Zl}/u, "a line separator"],
  [/\p{Zp}/u, "a paragraph separator"],
  [/\p{Cs}/u, "a lone surrogate"],
  [/\p{Co}/u, "a private-use character"],
];
// Markup that renders, notifies or hides text on a GitHub Release page, which
// installed apps show literally.
const FORBIDDEN_MARKUP = [
  [/`/, "a backtick"],
  [/\*/, "an asterisk"],
  [/<[A-Za-z/!?]/, "an HTML tag, comment or declaration"],
  [/\]\(/, "a Markdown link"],
  [/(?:^|[^A-Za-z0-9_])@[A-Za-z0-9-]/, "an @mention"],
];
// A leading marker would nest inside the release body's "- entry" lines or
// repeat the app's "• " bullet.
const LEADING_MARKER = /^(?:[-+•*] |#{1,6} |>|\d{1,9}[.)] )/;

export class ReleaseRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseRequestError";
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new ReleaseRequestError(`${field} must be a non-empty string`);
  }
  return value;
}

function codePointName(character) {
  const hex = character.codePointAt(0).toString(16).toUpperCase();
  return `U+${hex.padStart(4, "0")}`;
}

function validateEntry(value, description, codePoints) {
  const entry = requireString(value, description);
  const length = [...entry].length;
  if (length > codePoints) {
    throw new ReleaseRequestError(
      `${description} must be at most ${codePoints} code points (has ${length})`,
    );
  }
  if (entry.trim() !== entry) {
    throw new ReleaseRequestError(
      `${description} must not begin or end with whitespace`,
    );
  }
  const character = FORBIDDEN_CHARACTER.exec(entry)?.[0];
  if (character !== undefined) {
    const [, kind] = CHARACTER_KINDS.find(([pattern]) => pattern.test(character));
    throw new ReleaseRequestError(
      `${description} must not contain ${kind} (${codePointName(character)})`,
    );
  }
  for (const [pattern, markup] of FORBIDDEN_MARKUP) {
    if (pattern.test(entry)) {
      throw new ReleaseRequestError(`${description} must not contain ${markup}`);
    }
  }
  if (LEADING_MARKER.test(entry)) {
    throw new ReleaseRequestError(
      `${description} must not begin with a list, heading or quote marker`,
    );
  }
  return entry;
}

function validateEntries(value, description, limits) {
  if (!Array.isArray(value)) {
    throw new ReleaseRequestError(`${description} must be an array of strings`);
  }
  if (value.length < limits.minimum || value.length > limits.maximum) {
    throw new ReleaseRequestError(
      `${description} must contain ${limits.minimum}-${limits.maximum} entries`,
    );
  }
  return value.map((entry, index) =>
    validateEntry(entry, `${description}[${index}]`, limits.codePoints),
  );
}

function checkReleaseNotes(whatsNew, changes, names) {
  return {
    whats_new: validateEntries(whatsNew, names.whatsNew, WHATS_NEW_LIMITS),
    changes: validateEntries(changes, names.changes, CHANGES_LIMITS),
  };
}

// The lane's check before npm publish, and every request's: whats_new holds
// 1-4 entries of 1-140 code points, changes 0-40 entries of 1-300, each one
// line of plain text under the rules above. Returns the notes unchanged; a
// refusal names the entry ("whats_new[1]") and the rule it breaks.
export function validateReleaseNotes(notes) {
  if (notes === null || typeof notes !== "object" || Array.isArray(notes)) {
    throw new ReleaseRequestError(
      "release notes must be an object with whats_new and changes",
    );
  }
  return checkReleaseNotes(notes.whats_new, notes.changes, {
    whatsNew: "whats_new",
    changes: "changes",
  });
}

export function expectedReleaseTag(channel, version) {
  return channel === "stable"
    ? `ztc-desktop-v${version}`
    : `ztc-desktop-preview-v${version}`;
}

export function validateReleaseRequest(request) {
  if (
    request === null ||
    typeof request !== "object" ||
    Array.isArray(request)
  ) {
    throw new ReleaseRequestError("release request must be a JSON object");
  }
  const actualFields = Object.keys(request);
  const missing = EXPECTED_FIELDS.filter(
    (field) => !actualFields.includes(field),
  );
  if (missing.length > 0) {
    throw new ReleaseRequestError(`missing required field: ${missing[0]}`);
  }
  const unexpected = actualFields.filter(
    (field) => !EXPECTED_FIELDS.includes(field) && !NOTE_FIELDS.includes(field),
  );
  if (unexpected.length > 0) {
    throw new ReleaseRequestError(`unexpected field: ${unexpected[0]}`);
  }
  const noteFields = NOTE_FIELDS.filter((field) => actualFields.includes(field));
  if (noteFields.length === 1) {
    throw new ReleaseRequestError(
      "whats_new and changes must be present together",
    );
  }
  if (request.schema_version !== 1) {
    throw new ReleaseRequestError("schema_version must equal 1");
  }
  if (request.product !== "ZTC") {
    throw new ReleaseRequestError("product must equal ZTC");
  }
  if (request.source_repository !== "Epoch-ML/zerg") {
    throw new ReleaseRequestError("source_repository must equal Epoch-ML/zerg");
  }
  if (request.channel !== "preview" && request.channel !== "stable") {
    throw new ReleaseRequestError("channel must be preview or stable");
  }

  const version = requireString(request.version, "version");
  if (!SEMVER_PATTERN.test(version)) {
    throw new ReleaseRequestError(
      "version must be strict SemVer without a v prefix",
    );
  }
  if (
    request.channel === "stable" &&
    (version.includes("-") || version.includes("+"))
  ) {
    throw new ReleaseRequestError(
      "stable versions must use MAJOR.MINOR.PATCH without prerelease or build metadata",
    );
  }
  const sourceSha = requireString(request.source_sha, "source_sha");
  if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
    throw new ReleaseRequestError(
      "source_sha must contain exactly 40 lowercase hexadecimal characters",
    );
  }
  const expectedTag = expectedReleaseTag(request.channel, version);
  if (request.release_tag !== expectedTag) {
    throw new ReleaseRequestError(`release_tag must equal ${expectedTag}`);
  }
  const expectedRef = `refs/tags/${expectedTag}`;
  if (request.source_ref !== expectedRef) {
    throw new ReleaseRequestError(`source_ref must equal ${expectedRef}`);
  }
  const requestedAt = requireString(request.requested_at, "requested_at");
  if (
    Number.isNaN(Date.parse(requestedAt)) ||
    new Date(requestedAt).toISOString() !== requestedAt
  ) {
    throw new ReleaseRequestError(
      "requested_at must be an ISO-8601 UTC timestamp with milliseconds",
    );
  }
  const canonical = {
    schema_version: 1,
    product: "ZTC",
    channel: request.channel,
    version,
    release_tag: expectedTag,
    source_repository: "Epoch-ML/zerg",
    source_sha: sourceSha,
    source_ref: expectedRef,
    requested_at: requestedAt,
    npm: validateNpmIdentity(request.npm),
  };
  if (noteFields.length === 0) {
    return canonical;
  }
  return {
    ...canonical,
    ...validateReleaseNotes(request),
  };
}

export async function readReleaseRequest(path) {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new ReleaseRequestError(
      "release request path must identify a regular file, not a symbolic link",
    );
  }
  if (metadata.size > MAX_REQUEST_BYTES) {
    throw new ReleaseRequestError(
      `release request exceeds ${MAX_REQUEST_BYTES} bytes`,
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ReleaseRequestError(
      `release request is not valid JSON: ${error.message}`,
    );
  }
  return validateReleaseRequest(parsed);
}

// The npm package's stamped notes, validated, or null when it carries none.
export function releaseNotesFromPackage(pkg, request) {
  if (pkg?.name !== request.npm.name || pkg.version !== request.npm.version) {
    throw new ReleaseRequestError(
      "npm package.json must match the request's npm name and version",
    );
  }
  const release = pkg.zergRelease;
  if (release?.sourceCommit !== request.source_sha) {
    throw new ReleaseRequestError(
      "npm package zergRelease.sourceCommit must equal the request's source_sha",
    );
  }
  const carried = ["whatsNew", "changes"].filter((field) =>
    Object.hasOwn(release, field),
  );
  if (carried.length === 0) {
    return null;
  }
  if (carried.length === 1) {
    throw new ReleaseRequestError(
      "npm package zergRelease must carry whatsNew and changes together",
    );
  }
  return checkReleaseNotes(release.whatsNew, release.changes, {
    whatsNew: "zergRelease.whatsNew",
    changes: "zergRelease.changes",
  });
}

// The request must carry exactly the npm package's notes, or neither any.
export function requireReleaseNotesMatch(request, notes) {
  const requested = Object.hasOwn(request, "whats_new")
    ? { whats_new: request.whats_new, changes: request.changes }
    : null;
  if (JSON.stringify(requested) !== JSON.stringify(notes)) {
    throw new ReleaseRequestError(
      "the request's what's-new notes do not match the npm package's zergRelease",
    );
  }
}

function extractPackageJson(tarball) {
  return new Promise((resolve, reject) => {
    // tar reads the bytes that were hashed, never the path again.
    const child = execFile(
      "tar",
      ["-xOzf", "-", "package/package.json"],
      { encoding: "utf8", maxBuffer: MAX_PACKAGE_JSON_BYTES, timeout: 120_000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
    // tar may stop reading early; its exit status decides the result.
    child.stdin.on("error", () => {});
    child.stdin.end(tarball);
  });
}

async function readNpmPackageJson(tarballPath, npm) {
  const metadata = await lstat(tarballPath);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.size > MAX_NPM_TARBALL_BYTES
  ) {
    throw new ReleaseRequestError(
      `npm tarball must be a regular file of at most ${MAX_NPM_TARBALL_BYTES} bytes`,
    );
  }
  const tarball = await readFile(tarballPath);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (integrity !== npm.integrity) {
    throw new ReleaseRequestError(
      "npm tarball does not match the request's npm integrity",
    );
  }
  let text;
  try {
    text = await extractPackageJson(tarball);
  } catch (error) {
    throw new ReleaseRequestError(
      `npm tarball has no readable package/package.json: ${error.message}`,
    );
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ReleaseRequestError(
      `npm tarball package/package.json is not valid JSON: ${error.message}`,
    );
  }
}

// Copies the npm package's whats_new and changes into the request. The
// tarball must be the request's exact npm artifact, built from its source.
export async function readReleaseRequestWithNpmNotes(requestPath, tarballPath) {
  const request = await readReleaseRequest(requestPath);
  const notes = releaseNotesFromPackage(
    await readNpmPackageJson(tarballPath, request.npm),
    request,
  );
  if (!Object.hasOwn(request, "whats_new")) {
    // A request without notes takes the package's notes, if it carries any.
    return validateReleaseRequest({ ...request, ...notes });
  }
  requireReleaseNotesMatch(request, notes);
  return request;
}

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length !== 1 && paths.length !== 2) {
    throw new ReleaseRequestError(
      "usage: release-request.mjs REQUEST.json [NPM_TARBALL.tgz]",
    );
  }
  const request =
    paths.length === 1
      ? await readReleaseRequest(paths[0])
      : await readReleaseRequestWithNpmNotes(paths[0], paths[1]);
  process.stdout.write(`${JSON.stringify(request, null, 2)}\n`);
}

// Importing this module (the lane does, even from `node -e`) never runs main.
if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`release-request: ${error.message}`);
    process.exitCode = 1;
  });
}
