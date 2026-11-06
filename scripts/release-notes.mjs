// Release text derived from one immutable request (requests/<tag>.json).
// Stub: every request still gets the original text.
export const BRIDGE_NOTICE =
  "Bridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated.";

export function releaseBody(request) {
  return [
    `ZTC ${request.version} (${request.channel}).`,
    `Built from immutable Epoch-ML/zerg source commit \`${request.source_sha}\`.`,
    "The updater archive is signed independently from the macOS application signature.",
    BRIDGE_NOTICE,
  ].join("\n\n");
}

export function latestNotes(request) {
  return `ZTC ${request.channel} release from source ${request.source_sha}.`;
}

export function latestChanges() {
  return null;
}
