import { createElement, memo } from "react";
import {
  renderToPipeableStream,
  registerClientReference
} from "react-server-dom-webpack/server.node";
import { PassThrough } from "node:stream";
import { writeFile } from "node:fs/promises";

const result = {};

async function flight(element, manifest = {}) {
  let bytes = "";
  const errors = [];
  const output = new PassThrough();
  output.setEncoding("utf8");
  output.on("data", (value) => (bytes += value));

  const completed = new Promise((resolve, reject) => {
    output.on("end", resolve);
    output.on("error", reject);
  });

  renderToPipeableStream(element, manifest, {
    onError: (error) => {
      errors.push(error.message);

      return "probe-error";
    }
  }).pipe(output);
  await completed;

  return { errors, bytes, hasClientReference: /:I\[/.test(bytes) };
}

for (const name of ["local", "exported", "cssProp"]) {
  const { App, Box } = await import(`./${name}/${name}.js`);
  result[name] = await flight(createElement(App, { size: "large" }));

  if (Box) {
    result.polymorphic = await flight(
      createElement(App, { size: "small", as: "a" })
    );
    result.memo = await flight(
      createElement(memo(Box), { size: "large", children: "memo" })
    );
    result.ref = await flight(
      createElement(Box, { ref: () => {}, children: "ref" })
    );
    result.event = await flight(
      createElement(Box, { onClick: () => {}, children: "event" })
    );

    const Client = registerClientReference(
      function () {
        throw Error("client called on server");
      },
      "probe/client",
      "Widget"
    );

    result.clientAs = await flight(
      createElement(Box, { as: Client, size: "large", children: "client" }),
      { "probe/client": { id: "client-module", chunks: [], name: "Widget" } }
    );
  }
}

await writeFile(
  new URL("../rsc-results.json", import.meta.url),
  JSON.stringify(result, null, 2)
);
console.log(JSON.stringify(result, null, 2));
