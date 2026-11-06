export default {
  mutate: [
    "scripts/release-request.mjs:21-255",
    "scripts/release-request.mjs:280-386",
    "scripts/release-notes.mjs",
    "scripts/feed-policy.mjs:14-125",
    "scripts/release-asset-url.mjs:12-83",
    "scripts/verify-release-payload.mjs:26-407",
    "scripts/deploy-pages.mjs:15-278",
  ],
  testRunner: "tap",
  tap: {
    testFiles: [
      "scripts/feed-policy.test.mjs",
      "scripts/release-asset-url.test.mjs",
      "scripts/release-request.test.mjs",
      "scripts/release-notes-rules.test.mjs",
      "scripts/release-notes.test.mjs",
      "scripts/verify-release-payload.test.mjs",
      "scripts/deploy-pages.test.mjs",
    ],
  },
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "json"],
  jsonReporter: {
    fileName: "reports/mutation/mutation.json",
  },
};
