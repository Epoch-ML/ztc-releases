import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  ReleaseRequestError,
  releaseNotesFromPackage,
  validateReleaseNotes,
  validateReleaseRequest,
} from "./release-request.mjs";

// The one release-note rule set. The lane (Epoch-ML/zerg) carries this file
// byte for byte and runs every case against its own check before npm publish;
// change it only by copying the new shared file into both repositories.
const FIXTURE_BYTES = await readFile(
  new URL("./fixtures/release-notes-fixture.json", import.meta.url),
);
const FIXTURE = JSON.parse(FIXTURE_BYTES.toString("utf8"));
const FIXTURE_SHA256 = "3fc06e19ae22fed968e7b0bb017da45526093a36abc2f78a56dd75f3a8f3e0da";
const RELEASE_REQUEST_URL = new URL("./release-request.mjs", import.meta.url);

const IDENTITY = {
  schema_version: 1,
  product: "ZTC",
  channel: "preview",
  version: "0.12.0-beta.1",
  release_tag: "ztc-desktop-preview-v0.12.0-beta.1",
  source_repository: "Epoch-ML/zerg",
  source_sha: "1234567890abcdef1234567890abcdef12345678",
  source_ref: "refs/tags/ztc-desktop-preview-v0.12.0-beta.1",
  requested_at: "2026-11-12T18:00:00.000Z",
  npm: {
    name: "@zergai/ztc",
    version: "0.12.0-beta.1",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
    tarballUrl: "https://registry.npmjs.org/@zergai/ztc/-/ztc-0.12.0-beta.1.tgz",
  },
};

// Every way release notes reach the publisher must keep the same rules.
const ENTRY_POINTS = [
  {
    name: "validateReleaseNotes, the lane's check before npm publish,",
    fields: { whats_new: "whats_new", changes: "changes" },
    check: (notes) => validateReleaseNotes(notes),
  },
  {
    name: "a release request",
    fields: { whats_new: "whats_new", changes: "changes" },
    check: ({ whats_new, changes }) => {
      const request = validateReleaseRequest({ ...IDENTITY, whats_new, changes });
      return { whats_new: request.whats_new, changes: request.changes };
    },
  },
  {
    name: "the npm package's zergRelease",
    fields: { whats_new: "zergRelease.whatsNew", changes: "zergRelease.changes" },
    check: ({ whats_new, changes }) =>
      releaseNotesFromPackage(
        {
          name: "@zergai/ztc",
          version: IDENTITY.npm.version,
          zergRelease: { sourceCommit: IDENTITY.source_sha, whatsNew: whats_new, changes },
        },
        IDENTITY,
      ),
  },
];

// The rule each fixture reason names, as the refusal states it after the entry.
const ENTRY_RULES = new Map([
  ["empty", "must be a non-empty string"],
  ["not trimmed", "must not begin or end with whitespace"],
  ["control character", "must not contain a control character (U+"],
  ["format character", "must not contain a format character (U+"],
  ["line separator", "must not contain a line separator (U+2028)"],
  ["paragraph separator", "must not contain a paragraph separator (U+2029)"],
  ["private use", "must not contain a private-use character (U+"],
  ["backtick", "must not contain a backtick"],
  ["asterisk", "must not contain an asterisk"],
  ["html", "must not contain an HTML tag, comment or declaration"],
  ["markdown link", "must not contain a Markdown link"],
  ["mention", "must not contain an @mention"],
  ["leading block marker", "must not begin with a list, heading or quote marker"],
]);
const LENGTH_RULES = {
  whats_new: "must be at most 140 code points (has ",
  changes: "must be at most 300 code points (has ",
};
const LIST_RULES = new Map([
  ["whats_new needs at least one entry", ["whats_new", "must contain 1-4 entries"]],
  ["five highlights", ["whats_new", "must contain 1-4 entries"]],
  ["forty-one changes", ["changes", "must contain 0-40 entries"]],
]);

// Test names stay printable: invisible and non-ASCII characters are escaped.
function label(text) {
  const characters = [...text];
  const shown = characters.slice(0, 40).join("") + (characters.length > 40 ? "..." : "");
  return JSON.stringify(shown).replace(
    /[^\x20-\x7e]/gu,
    (character) => `\\u{${character.codePointAt(0).toString(16)}}`,
  );
}

function expectedRule(list, reason) {
  const rule = reason === "too long" ? LENGTH_RULES[list] : ENTRY_RULES.get(reason);
  assert.ok(rule !== undefined, `the fixture reason "${reason}" must map to a rule`);
  return rule;
}

function refusal(expectedStart) {
  return (error) => {
    assert.ok(error instanceof ReleaseRequestError, `${error}`);
    assert.ok(
      error.message.startsWith(expectedStart),
      `expected "${expectedStart}…", got "${error.message}"`,
    );
    return true;
  };
}

function fixtureCases(fields) {
  const highlight = FIXTURE.whats_new.accept[0];
  const change = FIXTURE.changes.accept[0];
  const cases = [];
  for (const text of FIXTURE.whats_new.accept) {
    cases.push({
      name: `accepts whats_new ${label(text)}`,
      notes: { whats_new: [text], changes: [] },
    });
  }
  for (const { text, reason } of FIXTURE.whats_new.reject) {
    cases.push({
      name: `refuses whats_new ${label(text)} (${reason})`,
      notes: { whats_new: [highlight, text], changes: [] },
      refusal: `${fields.whats_new}[1] ${expectedRule("whats_new", reason)}`,
    });
  }
  for (const text of FIXTURE.changes.accept) {
    cases.push({
      name: `accepts changes ${label(text)}`,
      notes: { whats_new: [highlight], changes: [text] },
    });
  }
  for (const { text, reason } of FIXTURE.changes.reject) {
    cases.push({
      name: `refuses changes ${label(text)} (${reason})`,
      notes: { whats_new: [highlight], changes: [change, text] },
      refusal: `${fields.changes}[1] ${expectedRule("changes", reason)}`,
    });
  }
  for (const { whats_new, changes, valid, reason } of FIXTURE.lists) {
    if (valid) {
      cases.push({ name: `accepts a list: ${reason}`, notes: { whats_new, changes } });
      continue;
    }
    const rule = LIST_RULES.get(reason);
    assert.ok(rule !== undefined, `the fixture list reason "${reason}" must map to a rule`);
    cases.push({
      name: `refuses a list: ${reason}`,
      notes: { whats_new, changes },
      refusal: `${fields[rule[0]]} ${rule[1]}`,
      exact: true,
    });
  }
  return cases;
}

test("the release-note fixture is the shared rules_version 1 file, byte for byte", () => {
  assert.equal(createHash("sha256").update(FIXTURE_BYTES).digest("hex"), FIXTURE_SHA256);
  assert.equal(FIXTURE.rules_version, 1);
  // Every reason the fixture gives maps to the rule this publisher states.
  for (const list of ["whats_new", "changes"]) {
    for (const { reason } of FIXTURE[list].reject) expectedRule(list, reason);
  }
});

for (const entryPoint of ENTRY_POINTS) {
  test(`${entryPoint.name} keeps every case of the shared release-note rules`, async (t) => {
    for (const fixtureCase of fixtureCases(entryPoint.fields)) {
      await t.test(fixtureCase.name, () => {
        if (fixtureCase.refusal === undefined) {
          assert.deepEqual(entryPoint.check(fixtureCase.notes), fixtureCase.notes);
          return;
        }
        assert.throws(
          () => entryPoint.check(fixtureCase.notes),
          fixtureCase.exact
            ? (error) => {
                assert.ok(error instanceof ReleaseRequestError, `${error}`);
                assert.equal(error.message, fixtureCase.refusal);
                return true;
              }
            : refusal(fixtureCase.refusal),
        );
      });
    }
  });
}

test("validateReleaseNotes takes { whats_new, changes } and returns the notes unchanged", () => {
  const notes = {
    whats_new: ["Emoji with a joiner 👩\u200d💻 work.", "Faster startup."],
    changes: ["Faster startup.", "Persian text with a zero-width non-joiner: نیم\u200cفاصله."],
  };
  assert.deepEqual(validateReleaseNotes(notes), notes);
  assert.deepEqual(validateReleaseNotes({ whats_new: ["Faster startup."], changes: [] }), {
    whats_new: ["Faster startup."],
    changes: [],
  });
  for (const notObject of [null, undefined, [], "Faster startup.", 7]) {
    assert.throws(
      () => validateReleaseNotes(notObject),
      (error) => {
        assert.ok(error instanceof ReleaseRequestError, `${error}`);
        assert.equal(error.message, "release notes must be an object with whats_new and changes");
        return true;
      },
      JSON.stringify(notObject),
    );
  }
  // The npm package's spelling (whatsNew) is not a request's notes.
  assert.throws(
    () => validateReleaseNotes({ whatsNew: ["Faster startup."], changes: [] }),
    refusal("whats_new must be an array of strings"),
  );
  assert.throws(
    () => validateReleaseNotes({ whats_new: ["Faster startup."] }),
    refusal("changes must be an array of strings"),
  );
});

test("refusals name the entry, the rule and the offending character", () => {
  const cases = [
    [{ whats_new: ["Fine.", "Zero\u200bwidth."], changes: [] }, "whats_new[1] must not contain a format character (U+200B)"],
    [{ whats_new: ["Fine."], changes: ["Fine.", "Fine.", "Bell\u0007."] }, "changes[2] must not contain a control character (U+0007)"],
    [{ whats_new: ["Private \u{F0000} plane."], changes: [] }, "whats_new[0] must not contain a private-use character (U+F0000)"],
    [{ whats_new: ["Lone \ud800 surrogate."], changes: [] }, "whats_new[0] must not contain a lone surrogate (U+D800)"],
    // The first forbidden character in the entry is the one named.
    [{ whats_new: ["Tab\tthen\u200bspace."], changes: [] }, "whats_new[0] must not contain a control character (U+0009)"],
    [{ whats_new: ["Space\u200bthen\ttab."], changes: [] }, "whats_new[0] must not contain a format character (U+200B)"],
    [{ whats_new: ["a".repeat(141)], changes: [] }, "whats_new[0] must be at most 140 code points (has 141)"],
    [{ whats_new: ["Fine."], changes: ["\u{1D400}".repeat(301)] }, "changes[0] must be at most 300 code points (has 301)"],
  ];
  for (const [notes, message] of cases) {
    assert.throws(
      () => validateReleaseNotes(notes),
      (error) => {
        assert.ok(error instanceof ReleaseRequestError, `${error}`);
        assert.equal(error.message, message);
        return true;
      },
      message,
    );
  }
});

test("a lane shell step can import validateReleaseNotes from an inline module", () => {
  // node -e without arguments leaves process.argv[1] undefined.
  const program = `
    import { validateReleaseNotes } from ${JSON.stringify(RELEASE_REQUEST_URL.href)};
    try {
      validateReleaseNotes(JSON.parse(process.env.RELEASE_NOTES));
      console.log("accepted");
    } catch (error) {
      console.log(error.message);
    }
  `;
  const run = (notes) =>
    spawnSync(process.execPath, ["--input-type=module", "-e", program], {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, RELEASE_NOTES: JSON.stringify(notes) },
    });
  const accepted = run({ whats_new: ["Emoji with a joiner 👩\u200d💻 work."], changes: [] });
  assert.deepEqual(
    { status: accepted.status, stdout: accepted.stdout, stderr: accepted.stderr },
    { status: 0, stdout: "accepted\n", stderr: "" },
  );
  const refused = run({ whats_new: ["Thanks @alice for the fix."], changes: [] });
  assert.deepEqual(
    { status: refused.status, stdout: refused.stdout, stderr: refused.stderr },
    { status: 0, stdout: "whats_new[0] must not contain an @mention\n", stderr: "" },
  );
});
