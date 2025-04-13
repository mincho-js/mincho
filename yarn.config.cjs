// @ts-check

const { defineConfig } = require("@yarnpkg/types");
const {
  ensureDependencyConsistency,
  enforceWorkspaceDependenciesWhenPossible,
  enforcePeerDependencyPresence
} = require("yarn-constraints-rules");

module.exports = defineConfig({
  constraints: async (ctx) => {
    ensureDependencyConsistency(ctx, {
      workspace: {
        dependencies: true,
        devDependencies: true,
        peerDependencies: true
      },
      external: {
        dependencies: false,
        devDependencies: false,
        peerDependencies: false
      }
    });
    enforceWorkspaceDependenciesWhenPossible(ctx);
    enforcePeerDependencyPresence(ctx, [
      "vite",
      "typescript",
      "eslint",
      "prettier"
    ]);
  }
});
