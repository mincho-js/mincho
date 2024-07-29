const { debugLog, jsonLog, jsonExpect } = require("@mincho-js/debug-log");

function main() {
  debugLog();
  console.log("test");

  debugLog("with title debugLog");
  console.log("test2");

  jsonLog({ key1: true, key2: 1, key3: null, key4: "string" });
  jsonLog("with title jsonLog", { others: undefined });

  jsonExpect({ a: 1 }, { a: 2 });
  jsonExpect("with title jsonExpect", { b: 1 }, { c: "1" });
}

main();
