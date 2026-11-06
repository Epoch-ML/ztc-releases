// Release text derived only from one immutable request (requests/<tag>.json).
// The workflows write it with release-notes.jq; the verifier compares against
// these functions, and release-notes.test.mjs requires identical bytes. A
// request without whats_new keeps the text published before what's-new notes.
const BRIDGE_NOTICE =
  "Bridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.";

function hasWhatsNew(request) {
  return Object.hasOwn(request, "whats_new");
}

function entryLines(entries, marker) {
  return entries.map((entry) => `${marker}${entry}`).join("\n");
}

export function releaseBody(request) {
  const paragraphs = [
    `ZTC ${request.version} (${request.channel}).`,
    `Built from immutable Epoch-ML/zerg source commit \`${request.source_sha}\`.`,
    "The updater archive is signed independently from the macOS application signature.",
    BRIDGE_NOTICE,
  ];
  if (hasWhatsNew(request)) {
    paragraphs.push(`What's new:\n${entryLines(request.whats_new, "- ")}`);
    if (request.changes.length > 0) {
      paragraphs.push(`All changes:\n${entryLines(request.changes, "- ")}`);
    }
  }
  return paragraphs.join("\n\n");
}

export function latestNotes(request) {
  return hasWhatsNew(request)
    ? entryLines(request.whats_new, "• ")
    : `ZTC ${request.channel} release from source ${request.source_sha}.`;
}

// The latest.json changes list, or null when latest.json carries none.
export function latestChanges(request) {
  return hasWhatsNew(request) && request.changes.length > 0
    ? [...request.changes]
    : null;
}
