# Release text derived only from one immutable request (requests/<tag>.json).
# Every step of release.yml and activate.yml that writes or compares a release
# body or latest.json notes includes this file, so nothing is typed at publish
# time. A request without whats_new (every release before what's-new notes)
# keeps its original text. release-notes.mjs holds the verifier's copy of
# these rules; release-notes.test.mjs requires both to produce identical bytes.

def entry_lines($marker): map($marker + .) | join("\n");

# GitHub Release body: the fixed paragraphs, then "What's new:" and, when the
# request lists changes, "All changes:", each with one "- entry" line per entry.
def release_body:
  [
    "ZTC \(.version) (\(.channel)).",
    "Built from immutable Epoch-ML/zerg source commit `\(.source_sha)`.",
    "The updater archive is signed independently from the macOS application signature.",
    "Bridge notice: ZTC-launched ZTC 0.1.2 sessions cannot complete this transition in-app. Install this release from the signed DMG once. Signed updates with session restoration are supported by this release; availability starts when the update feed is activated."
  ]
  + (if has("whats_new") then ["What's new:\n" + (.whats_new | entry_lines("- "))] else [] end)
  + (if has("whats_new") and (.changes | length) > 0
     then ["All changes:\n" + (.changes | entry_lines("- "))]
     else []
     end)
  | join("\n\n");

# latest.json notes: one "• entry" line per whats_new entry. Every installed
# app shows this string line by line in its Updates window.
def latest_notes:
  if has("whats_new") then .whats_new | entry_lines("• ")
  else "ZTC \(.channel) release from source \(.source_sha)."
  end;

# latest.json changes: the request's list, present only when it is not empty.
def latest_changes:
  if has("whats_new") and (.changes | length) > 0 then {changes: .changes} else {} end;
