// Run in a fresh process with the selected checkout's PnP hook, after its build.
const { createRequire } = require("node:module");
const { mkdirSync, writeFileSync, readFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const { gzipSync } = require("node:zlib");
const [root, output, scenario, optimize = "true"] = process.argv.slice(2);
const projectRequire = createRequire(
  join(root, "packages/esbuild/package.json")
);

const { build, transform } = projectRequire("esbuild");
const { minchoEsbuildPlugins } = projectRequire(
  join(root, "packages/esbuild/dist/cjs/index.cjs")
);

const directory = join(
  root,
  "packages/react/.cache/compiler-helpers",
  scenario
);

mkdirSync(directory, { recursive: true });
mkdirSync(output, { recursive: true });

const props = [
  "width",
  "height",
  "minWidth",
  "minHeight",
  "maxWidth",
  "maxHeight",
  "marginTop",
  "marginBottom",
  "marginLeft",
  "marginRight",
  "paddingTop",
  "paddingBottom",
  "paddingLeft",
  "paddingRight",
  "borderTopWidth",
  "borderBottomWidth"
];

const recipe = `import {rules} from "@mincho-js/css";
const recipe=rules({base:{display:"block"},variants:{tone:{red:{color:"red"},blue:{color:"blue"}},size:{sm:{fontSize:12},lg:{fontSize:18}}},defaultVariants:{tone:"red",size:"sm"},compoundVariants:[{variants:{tone:"blue",size:"lg"},style:{fontWeight:700}}],props:["width","height","color"]});`;

let source;

if (
  scenario.startsWith("props") ||
  scenario === "both" ||
  scenario === "classes"
) {
  const value =
    scenario === "props-static"
      ? "recipe.props({width:input.width,color:input.color})"
      : scenario === "classes"
        ? "recipe({tone:input.tone,size:input.size})"
        : scenario === "both"
          ? "({className:recipe({tone:input.tone,size:input.size}),style:recipe.props(input)})"
          : "recipe.props(input)";

  source = recipe + `export function run(input) {return ${value};}`;
} else {
  source = "function element(type, props) {return props;}\n";

  if (scenario === "cascade") {
    source +=
      'export function run(input) {return <div data-active css={{padding:input.f0?"8px":"4px",paddingLeft:input.f1?"16px":"2px",marginInlineStart:input.f2?"3px":"1px",marginLeft:input.f3?"7px":"5px",selectors:{"&[data-active]":{color:input.f4?"purple":"green"}},"@media":{"(min-width: 0px)":{opacity:input.f0?1:0.5}}}}/>;}';
  } else if (scenario.startsWith("conditions")) {
    const count = Number(scenario.replace("conditions", ""));
    const keys = [
      "color",
      "backgroundColor",
      "display",
      "position",
      "overflow"
    ];

    const choices = [
      ["red", "blue"],
      ["white", "black"],
      ["flex", "block"],
      ["relative", "absolute"],
      ["hidden", "auto"]
    ];

    source += `export function run(input) {return <div css={{${keys
      .slice(0, count)
      .map(
        (key, i) => `${key}:input.f${i}?"${choices[i][0]}":"${choices[i][1]}"`
      )
      .join(",")}}}/>;}`;
  } else {
    const spread = scenario.startsWith("spreads");
    const count = spread ? Number(scenario.replace("spreads", "")) : 10;
    const variables = spread ? 2 : Number(scenario.replace("vars", ""));
    const declarations = props
      .slice(0, variables)
      .map((key) => `${key}:+input.${key}`)
      .join(",");

    for (let i = 0; i < count; i++)
      source += `function view${i}(input) {return <div ${spread ? 'id="before" {...input.pre} ' : ""}css={{${declarations}}} ${spread ? 'title="after" {...input.post}' : ""}/>;}\n`;

    source += `const views=[${Array.from({ length: count }, (_, i) => `view${i}`).join(",")}];export function run(input,i=0){return views[i%views.length](input);}`;
  }
}

writeFileSync(join(directory, "entry.tsx"), source);

const sizes = (text) => ({
  raw: Buffer.byteLength(text),
  gzip: gzipSync(text).length
});

(async () => {
  const report = { scenario, optimize, formats: {} };

  for (const format of ["esm", "cjs"]) {
    const times = [];
    let result;

    // First build warms the compiler; subsequent samples use fresh plugins and no disk cache.
    for (let i = 0; i < 4; i++) {
      const start = performance.now();
      result = await build({
        absWorkingDir: directory,
        entryPoints: ["entry.tsx"],
        outdir: join(directory, "dist"),
        bundle: true,
        minify: true,
        minifyIdentifiers: false,
        minifySyntax: false,
        minifyWhitespace: false,
        write: false,
        format,
        jsxFactory: "element",
        logLevel: "silent",
        metafile: true,
        plugins: minchoEsbuildPlugins({
          jsxCssProp: true,
          cache: false,
          optimize: { runtimeCodegen: optimize === "true" }
        })
      });

      if (i > 0) times.push(performance.now() - start);
    }

    const code = result.outputFiles.find((file) =>
      file.path.endsWith(".js")
    ).text;

    const css = (
      await transform(
        result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ??
          "",
        { loader: "css", minify: true }
      )
    ).code;

    const minified = await build({
      stdin: { contents: code, resolveDir: directory },
      write: false,
      bundle: true,
      minify: true,
      format,
      logLevel: "silent"
    });

    const compact = minified.outputFiles[0].text;
    writeFileSync(
      join(output, `${scenario}.${format === "esm" ? "mjs" : "cjs"}`),
      compact
    );
    writeFileSync(join(output, `${scenario}.${format}.js`), code);
    writeFileSync(join(output, `${scenario}.css`), css);
    report.formats[format] = {
      js: sizes(compact),
      css: sizes(css),
      buildMs: times,
      inputs: Object.keys(result.metafile.inputs),
      retainedInputs: Object.entries(
        Object.values(result.metafile.outputs).find((item) => item.entryPoint)
          ?.inputs ?? {}
      )
        .filter(([, v]) => v.bytesInOutput > 0)
        .map(([id]) => id)
    };
  }

  writeFileSync(
    join(output, `${scenario}.json`),
    JSON.stringify(report, null, 2)
  );
  process.stdout.write(JSON.stringify(report) + "\n");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
