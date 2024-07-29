const { debugLog, jsonLog, jsonExpect } = require("@mincho-js/debug-log");

async function main() {
  await debugLog();
  console.log("test");

  await debugLog("with title debugLog");
  console.log("test2");

  await jsonLog({ key1: true, key2: 1, key3: null, key4: "string" });
  await jsonLog("with title jsonLog", { others: undefined });

  await jsonExpect({ a: 1 }, { a: 2 });
  await jsonExpect("with title jsonExpect", { b: 1 }, { c: "1" });
}

main();
