import {
  endFileScope,
  hasFileScope,
  setFileScope
} from "@vanilla-extract/css/fileScope";
import { afterAll, bench, describe } from "vitest";
import type { ClassValue } from "../classname/index.js";
import { defineRules } from "./index.js";

type Props = { className: string };

setFileScope("metadata.bench.ts", "@mincho-js/css");

const runtime = defineRules({
  debugId: "cxCacheBench",
  properties: {
    color: true,
    backgroundColor: true,
    display: true,
    padding: true
  }
});

const registeredClassLists = [
  runtime.css({ color: "red", backgroundColor: "blue", display: "block" }),
  runtime.css({ color: "blue", backgroundColor: "white", display: "flex" }),
  runtime.css({ color: "red", padding: 8, display: "flex" })
] as const;
const colorRed = runtime.css({ color: "red" });
const colorBlue = runtime.css({ color: "blue" });
const displayFlex = runtime.css({ display: "flex" });
const paddingSmall = runtime.css({ padding: 4 });
const paddingLarge = runtime.css({ padding: 8 });
const fullResultInput: ClassValue[] = [
  registeredClassLists[0],
  [registeredClassLists[1], { [displayFlex]: true }],
  [paddingSmall, [paddingLarge]]
];
const repeatedExternalProps = Array.from(
  { length: 5 },
  (_, index): Props => ({
    className: `external-prop-${index} ${colorRed} ${colorBlue} ${displayFlex}`
  })
);
let cacheEvictionBatch = 0;
let uniqueExternalBatch = 0;

function evictFullResultCache(): void {
  const batch = cacheEvictionBatch;
  cacheEvictionBatch += 1;

  for (let index = 0; index < 4; index += 1) {
    runtime.cx(`full-result-evict-${batch}-${index}`);
  }
}

function cxFullResultInput(): string {
  return runtime.cx(...fullResultInput);
}

for (const classList of registeredClassLists) {
  runtime.cx(classList);
}
for (const props of repeatedExternalProps) {
  runtime.cx(props.className);
}
cxFullResultInput();

afterAll(() => {
  while (hasFileScope()) {
    endFileScope();
  }
});

describe("defineRules scoped cx cache fast paths", () => {
  bench(
    "registeredSegments hit and epoch merge for 3 known class lists",
    () => {
      evictFullResultCache();

      for (const classList of registeredClassLists) {
        runtime.cx(classList);
      }
    }
  );

  bench("bounded segment LRU hit for repeated external props.className", () => {
    evictFullResultCache();

    for (const props of repeatedExternalProps) {
      runtime.cx(props.className);
    }
  });

  bench("bounded segment LRU miss for 1000 unique external strings", () => {
    const batch = uniqueExternalBatch;
    uniqueExternalBatch += 1;

    for (let index = 0; index < 1000; index += 1) {
      runtime.cx(
        `external-miss-${batch}-${index} ${colorRed} ${colorBlue} unknown-${index}`
      );
    }
  });

  bench(
    "full-result cache hit for repeated identical flattened input size 4",
    () => {
      cxFullResultInput();
    }
  );
});
