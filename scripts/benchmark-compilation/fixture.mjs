import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const cases = [
  "recipe",
  "mixed-recipe",
  "static-styled",
  "dynamic-styled",
  "styles-24",
  "styles-240",
  "shared-24",
  "plain-240"
];

const style = (size, shared) =>
  "{base:" +
  (shared ? "base" : "{color:'red'}") +
  ",variants:{size:{small:{padding:4},large:{padding:8}},active:{true:{opacity:1}}}," +
  "defaultVariants:{size:'" +
  size +
  "'}," +
  "compoundVariants:({size,active})=>[{condition:[size.large,active.true],style:{background:'blue'}}]}";

export function entryName(format, name) {
  return name.includes("styled")
    ? "entry.tsx"
    : format === "cjs"
      ? "entry.cts"
      : "entry.ts";
}

export async function producer(
  directory,
  name,
  format,
  size = "small",
  index = 0
) {
  const styled = name.includes("styled");
  const multiple = /^(styles|shared)-/.test(name);
  const shared = name.startsWith("shared-");
  const symbol = styled ? "Button" : "button" + (multiple ? index : "");
  const extension = format === "cjs" ? "cts" : "ts";
  const file = join(
    directory,
    "styles" + (multiple ? index : "") + "." + extension
  );

  const source = "@mincho-js/" + (styled ? "react" : "css");
  const api = styled ? "styled" : "rules";
  const imports =
    format === "cjs"
      ? "const {" + api + "}=require('" + source + "');"
      : "import {" + api + "} from '" + source + "';";

  const tokens = !shared
    ? ""
    : format === "cjs"
      ? "const {base}=require('./tokens.cts');"
      : "import {base} from './tokens';";

  await writeFile(
    file,
    imports +
      tokens +
      "const " +
      symbol +
      "=" +
      (styled ? "styled.button" : "rules") +
      "(" +
      style(size, shared) +
      ");" +
      (format === "cjs"
        ? "exports." + symbol + "=" + symbol + ";"
        : "export {" + symbol + "};")
  );
}

export async function prepare(root, name, format) {
  const directory = join(root, format, name);
  await mkdir(join(directory, "output"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "mincho-compilation-benchmark",
      version: "0.0.0",
      type: "module",
      sideEffects: true
    })
  );

  const commonJs = format === "cjs";
  const extension = commonJs ? "cts" : "ts";

  const importValue = (symbol, source) =>
    commonJs
      ? "const {" + symbol + "}=require('" + source + "');"
      : "import {" + symbol + "} from '" + source + "';";

  const exportValue = (symbol, value) =>
    commonJs
      ? "exports." + symbol + "=" + value + ";"
      : "export const " + symbol + "=" + value + ";";

  let entry;

  if (name.startsWith("plain-")) {
    const count = Number(name.split("-")[1]);
    const imports = [];

    for (let index = 0; index < count; index++) {
      await writeFile(
        join(directory, "plain" + index + "." + extension),
        exportValue("value" + index, index)
      );
      imports.push(
        importValue("value" + index, "./plain" + index + "." + extension)
      );
    }

    entry =
      imports.join("\n") +
      exportValue(
        "classes",
        "[" +
          Array.from({ length: count }, (_, index) => "value" + index).join(
            ","
          ) +
          "]"
      );
  } else if (/^(styles|shared)-/.test(name)) {
    const count = Number(name.split("-")[1]);

    if (name.startsWith("shared-"))
      await writeFile(
        join(directory, "tokens." + extension),
        exportValue("base", "{color:'red'}")
      );

    const imports = [];

    for (let index = 0; index < count; index++) {
      await producer(directory, name, format, "small", index);
      imports.push(
        importValue("button" + index, "./styles" + index + "." + extension)
      );
    }

    entry =
      imports.join("\n") +
      exportValue(
        "classes",
        "[" +
          Array.from(
            { length: count },
            (_, index) => "button" + index + "()"
          ).join(",") +
          "]"
      );
  } else if (name.includes("styled")) {
    await producer(directory, name, format);
    await writeFile(
      join(directory, "barrel." + extension),
      commonJs
        ? "module.exports=require('./styles.cts');"
        : "export {Button} from './styles';"
    );

    const size =
      name === "static-styled" ? '"large"' : '{tick%2?"large":"small"}';

    entry =
      importValue("Button", "./barrel." + extension) +
      exportValue(
        "App",
        "({count=50,tick=0})=><div>{Array.from({length:count},(_,index)=><Button key={index} size=" +
          size +
          ' active className="extra" data-index={index} data-tick={tick}>{index}</Button>)}</div>'
      );
  } else {
    await producer(directory, name, format);
    entry =
      importValue("button", "./styles." + extension) +
      exportValue(
        "classes",
        "[" +
          Array.from(
            { length: 12 },
            (_, index) =>
              "button(" + (index % 2 ? "{size:'large',active:true}" : "") + ")"
          ).join(",") +
          "]"
      );

    if (name === "mixed-recipe")
      entry +=
        (commonJs ? "exports.button=button;" : "export {button};") +
        exportValue("dynamic", "options=>button(options)");
  }

  await writeFile(join(directory, entryName(format, name)), entry);

  return directory;
}

export async function edit(directory, name, format, value) {
  if (name.startsWith("plain-")) {
    const source =
      format === "cjs" ? "exports.value0=" : "export const value0=";

    await writeFile(
      join(directory, "plain0." + (format === "cjs" ? "cts" : "ts")),
      source + value + ";"
    );
  } else await producer(directory, name, format, value % 2 ? "large" : "small");
}

export async function editShared(directory, format, value) {
  await writeFile(
    join(directory, "tokens." + (format === "cjs" ? "cts" : "ts")),
    (format === "cjs" ? "exports.base=" : "export const base=") +
      "{color:'" +
      (value % 2 ? "blue" : "red") +
      "'};"
  );
}
