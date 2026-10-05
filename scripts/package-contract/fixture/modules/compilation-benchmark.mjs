import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { performance } from "node:perf_hooks";
import { context } from "esbuild";
import { minchoEsbuildPlugins } from "@mincho-js/esbuild";

const root = resolve("fixture/modules/compilation-benchmark");
await mkdir(root, { recursive: true });
await writeFile(
  join(root, "package.json"),
  JSON.stringify({ name: "mincho-benchmark", sideEffects: true })
);
await writeFile(
  join(root, "entry.ts"),
  `import { button } from "./styles"; export const classes = [${Array.from({ length: 12 }, (_, index) => `button(${index % 2 ? '{ size: "large" }' : ""})`).join(",")}];`
);

const producer = (size) =>
  `import { rules } from "@mincho-js/css"; export const button = rules({ base: { color: "red" }, variants: { size: { small: { padding: 4 }, large: { padding: 8 } } }, defaultVariants: { size: "${size}" } });`;

const modes = {
  baseline: { cache: false, optimize: false },
  optimizedUncached: { cache: false, optimize: true },
  optimized: { cache: true, optimize: true }
};

const measurements = Object.fromEntries(
  Object.keys(modes).map((mode) => [mode, []])
);

let referenceCss;

for (let round = 0; round < 3; round++) {
  // Each mode runs once in each position to reduce warm-process bias.
  const order = Object.keys(modes);

  for (const mode of [...order.slice(round), ...order.slice(0, round)]) {
    const { cache, optimize } = modes[mode];
    await writeFile(join(root, "styles.ts"), producer("small"));

    const build = await context({
      absWorkingDir: root,
      entryPoints: ["entry.ts"],
      outdir: join(root, "dist"),
      bundle: true,
      write: false,
      format: "esm",
      minify: true,
      logLevel: "silent",
      plugins: minchoEsbuildPlugins({
        cache,
        optimize: {
          pureFunctions: optimize,
          staticRecipes: optimize,
          styledComponents: optimize,
          runtimeCodegen: optimize
        }
      })
    });

    const measure = async () => {
      const start = performance.now();
      const result = await build.rebuild();
      const milliseconds = performance.now() - start;
      const css = result.outputFiles.find((file) =>
        file.path.endsWith(".css")
      ).text;

      referenceCss ??= css;

      assert.equal(css, referenceCss);
      const javascript = result.outputFiles.find((file) =>
        file.path.endsWith(".js")
      ).text;
      const { classes } = await import(
        `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`
      );

      return {
        milliseconds,
        classes,
        js: result.outputFiles
          .filter((file) => file.path.endsWith(".js"))
          .reduce((bytes, file) => bytes + file.contents.length, 0)
      };
    };

    try {
      const cold = await measure();
      const unchanged = await measure();
      assert.deepEqual(unchanged.classes, cold.classes);
      assert.equal(unchanged.classes.length, 12);
      assert.notEqual(unchanged.classes[0], unchanged.classes[1]);
      await writeFile(join(root, "styles.ts"), producer("large"));

      const edited = await measure();
      assert.notDeepEqual(edited.classes, unchanged.classes);
      assert.deepEqual(edited.classes, Array(12).fill(unchanged.classes[1]));
      measurements[mode].push({
        cold,
        unchanged,
        edited
      });
    } finally {
      await build.dispose();
    }
  }
}

const median = (values) =>
  values.sort((left, right) => left - right)[Math.floor(values.length / 2)];

const report = Object.fromEntries(
  Object.entries(measurements).map(([mode, rounds]) => [
    mode,
    Object.fromEntries(
      ["cold", "unchanged", "edited"].map((phase) => [
        phase,
        {
          milliseconds:
            Math.round(
              median(rounds.map((round) => round[phase].milliseconds)) * 10
            ) / 10,
          js: median(rounds.map((round) => round[phase].js))
        }
      ])
    )
  ])
);

await writeFile(
  join(root, "report.json"),
  JSON.stringify(
    {
      note: "Three new contexts in one process, rotating mode order; timings are observational, not pass/fail thresholds.",
      measurements,
      median: report
    },
    null,
    2
  )
);
console.log(`[compilation-benchmark] ${JSON.stringify(report)}`);
