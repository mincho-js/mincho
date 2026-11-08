import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const site = fileURLToPath(new URL("../", import.meta.url));
const result = await build({
  absWorkingDir: site,
  entryPoints: ["examples/workflow/index.ts"],
  outfile: "src/generated/workflow.mjs",
  bundle: true,
  format: "esm",
  platform: "browser",
  tsconfig: "tsconfig.app.json",
  jsx: "automatic",
  external: ["react", "react/jsx-runtime"],
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: minchoEsbuildPlugins({ identifiers: "debug" }),
  write: false
});

await mkdir(new URL("../src/generated/", import.meta.url), { recursive: true });
for (const output of result.outputFiles) {
  // Avoid restarting Next's dev server when the example hasn't changed.
  const previous = await readFile(output.path).catch(() => null);
  if (!previous?.equals(output.contents)) {
    await writeFile(output.path, output.contents);
  }
}
console.log(
  "Compiled the landing-page example into static CSS and a React component."
);
