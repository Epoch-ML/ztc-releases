# Release text derived from one immutable request (requests/<tag>.json).
# Stub: every request still gets the original text.

def release_body:
  [
    "ZTC \(.version) (\(.channel)).",
    "Built from immutable Epoch-ML/zerg source commit `\(.source_sha)`.",
    "The updater archive is signed independently from the macOS application signature.",
    "Bridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated."
  ]
  | join("\n\n");

def latest_notes: "ZTC \(.channel) release from source \(.source_sha).";

def latest_changes: {};
