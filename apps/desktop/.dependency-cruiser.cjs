/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-feature-to-feature",
      // Existing edges are reported during the migration; new violations are
      // still visible in CI without making the current branch unbuildable.
      severity: "warn",
      comment:
        "Features must depend on shared primitives or services, not on another feature's internals. Existing cross-feature edges are temporarily exempted and must be removed during feature-boundary refactoring.",
      from: {
        path: "^src/features/([^/]+)/",
        pathNot: "\\.test\\.(ts|tsx)$",
      },
      to: {
        path: "^src/features/[^/]+/",
        pathNot: "^src/features/$1/",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {},
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
