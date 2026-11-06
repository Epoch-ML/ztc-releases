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
const WHATS_NEW_LIMITS = { minimum: 1, maximum: 4, characters: 140 };
const CHANGES_LIMITS = { minimum: 0, maximum: 40, characters: 300 };
const MAX_NPM_TARBALL_BYTES = 256 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SOURCE_SHA_PATTERN = /^[0-9a-f]{40}$/;
// Controls (tabs and line breaks too), format characters such as bidi
// overrides and zero-width marks, line and paragraph separators, lone
// surrogates and private-use characters.
const UNSAFE_CHARACTER = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}\p{Co}]/u;
// Code spans, emphasis and HTML tags render differently on GitHub than as the
// plain text the app shows.
const MARKUP = /[`*]|<[A-Za-z/!?]/;
// A leading marker would nest inside the release body's "- entry" lines or
// repeat the app's "• " bullet.
const BLOCK_MARKER = /^(?:[-+•] |#{1,6} |>)/;

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

function validateEntry(value, description, characters) {
  const entry = requireString(value, description);
  if ([...entry].length > characters) {
    throw new ReleaseRequestError(
      `${description} must be at most ${characters} characters`,
    );
  }
  if (entry.trim() !== entry) {
    throw new ReleaseRequestError(
      `${description} must not begin or end with whitespace`,
    );
  }
  if (UNSAFE_CHARACTER.test(entry)) {
    throw new ReleaseRequestError(
      `${description} must be one line of plain text without control, format or separator characters`,
    );
  }
  if (MARKUP.test(entry)) {
    throw new ReleaseRequestError(
      `${description} must be plain text without Markdown or HTML markup`,
    );
  }
  if (BLOCK_MARKER.test(entry)) {
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
    validateEntry(entry, `${description}[${index}]`, limits.characters),
  );
}

// whats_new: 1-4 entries of at most 140 characters; changes: 0-40 entries of
// at most 300. Each entry is one line of plain text; nothing is rewritten.
export function validateReleaseNotes(
  whatsNew,
  changes,
  names = { whatsNew: "whats_new", changes: "changes" },
) {
  return {
    whats_new: validateEntries(whatsNew, names.whatsNew, WHATS_NEW_LIMITS),
    changes: validateEntries(changes, names.changes, CHANGES_LIMITS),
  };
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
    ...validateReleaseNotes(request.whats_new, request.changes),
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
  return validateReleaseNotes(release.whatsNew, release.changes, {
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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`release-request: ${error.message}`);
    process.exitCode = 1;
  });
}
