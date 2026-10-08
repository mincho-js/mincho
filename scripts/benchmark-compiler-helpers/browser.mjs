// Verify the actual CSS produced by both checkouts, including every condition mask.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const directory = resolve(process.argv[2]);
const binary = process.env.MINCHO_BROWSER_BINARY;

assert.ok(binary, "Set MINCHO_BROWSER_BINARY to an installed Chromium binary");

const cases = [];

for (const version of ["before", "after"])
  for (const scenario of ["conditions5", "cascade"]) {
    const { run } = await import(
      pathToFileURL(join(directory, version, `${scenario}.mjs`))
    );

    const css = await readFile(
      join(directory, version, `${scenario}.css`),
      "utf8"
    );

    for (let mask = 0; mask < 32; mask++) {
      const flags = Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => [`f${i}`, !!(mask & (1 << i))])
      );

      const props = run(flags);
      const expected =
        scenario === "conditions5"
          ? {
              color: flags.f0 ? "rgb(255, 0, 0)" : "rgb(0, 0, 255)",
              backgroundColor: flags.f1 ? "rgb(255, 255, 255)" : "rgb(0, 0, 0)",
              display: flags.f2 ? "flex" : "block",
              position: flags.f3 ? "relative" : "absolute",
              overflow: flags.f4 ? "hidden" : "auto"
            }
          : {
              paddingTop: flags.f0 ? "8px" : "4px",
              paddingLeft: flags.f1 ? "16px" : "2px",
              marginLeft: flags.f3 ? "7px" : "5px",
              color: flags.f4 ? "rgb(128, 0, 128)" : "rgb(0, 128, 0)",
              opacity: flags.f0 ? "1" : "0.5"
            };

      cases.push({
        id: `${version}/${scenario}/${mask}`,
        css,
        props,
        expected
      });
    }
  }

const temporary = await mkdtemp(join(tmpdir(), "mincho-helpers-browser-"));

try {
  const page = join(temporary, "index.html");
  const data = JSON.stringify(cases).replace(/</g, "\\u003c");
  await writeFile(
    page,
    `<!doctype html><meta charset="utf-8"><body><pre id="result"></pre><script>
  const cases=${data}; const output=[];
  for(const item of cases){
    const host=document.createElement("div");document.body.append(host);
    const root=host.attachShadow({mode:"open"});const sheet=document.createElement("style");sheet.textContent=item.css;root.append(sheet);
    const element=document.createElement("div");element.className=item.props.className;
    element.setAttribute("data-active","");root.append(element);
    const style=getComputedStyle(element);
    output.push({id:item.id,actual:Object.fromEntries(Object.keys(item.expected).map(key=>[key,style[key]]))});
  }
  document.getElementById("result").textContent=JSON.stringify(output);
  </script>`
  );

  const { stdout } = await promisify(execFile)(
    binary,
    [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--dump-dom",
      `--user-data-dir=${join(temporary, "profile")}`,
      page
    ],
    { maxBuffer: 4 * 1024 * 1024, timeout: 60000 }
  );

  const results = JSON.parse(
    stdout
      .match(/<pre id="result">(.*?)<\/pre>/s)[1]
      .replaceAll("&quot;", '"')
      .replaceAll("&amp;", "&")
  );

  assert.equal(results.length, cases.length);

  for (let i = 0; i < cases.length; i++)
    assert.deepEqual(results[i].actual, cases[i].expected, cases[i].id);

  console.log(
    `Browser CSS: ${cases.length} cases passed (independent, shorthand, logical/physical, selector and media rules).`
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
