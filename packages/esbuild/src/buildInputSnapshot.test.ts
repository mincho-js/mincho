import { afterEach, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import {
  BuildInputSnapshot,
  effectiveLoader,
  observeLoad,
  recordPackageGraph,
  type BuildTransaction
} from "./buildInputSnapshot.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))
  );
});

async function temporaryRoot() {
  const parent = resolve(process.cwd(), ".test-build-snapshot");
  await fs.mkdir(parent, { recursive: true });

  const root = await fs.mkdtemp(join(parent, "case-"));
  roots.push(root);

  return root;
}

it("does not leak a failed read into the next transaction", async () => {
  const root = await temporaryRoot();
  const path = join(root, "entry.js");
  const failed = new BuildInputSnapshot();

  await expect(failed.readFile(path)).rejects.toThrow();

  await fs.writeFile(path, "export default 42");

  expect((await new BuildInputSnapshot().readFile(path)).toString()).toContain(
    "42"
  );
});

it("detects configuration creation after native input analysis", async () => {
  const root = await temporaryRoot();
  const path = join(root, "entry.js");
  await fs.writeFile(path, "export default 42");

  const snapshot = new BuildInputSnapshot();
  await snapshot.readFile(path);
  await fs.writeFile(join(root, "package.json"), '{"sideEffects":false}');

  await expect(snapshot.validate()).rejects.toThrow("configuration changed");
});

it.each(["missing", "changed", "deleted"])(
  "observes optional files that are %s without retaining failed reads",
  async (state) => {
    const root = await temporaryRoot();
    const path = join(root, "entry.js.map");
    if (state !== "missing") await fs.writeFile(path, "original map");

    const snapshot = new BuildInputSnapshot();
    expect((await snapshot.readOptionalFile(path))?.toString() ?? null).toBe(
      state === "missing" ? null : "original map"
    );
    await expect(snapshot.validate()).resolves.toBeUndefined();

    if (state === "deleted") await fs.rm(path);
    else await fs.writeFile(path, "new map");

    // Both passes must read the same snapshot, including an absent map.
    expect((await snapshot.readOptionalFile(path))?.toString() ?? null).toBe(
      state === "missing" ? null : "original map"
    );
    await expect(snapshot.validate()).rejects.toThrow("configuration changed");
  }
);

it.each(["namespace", "suffix", "loader"] as const)(
  "distinguishes %s in transformed input identities",
  (changed) => {
    const snapshot = new BuildInputSnapshot();
    const transaction: BuildTransaction = {
      phase: "analyze",
      snapshot,
      graphs: new Map(),
      styles: new Map()
    };

    const args = {
      path: "/entry.js",
      namespace: "file",
      suffix: "",
      pluginData: undefined,
      with: {}
    };

    observeLoad(transaction, args, {
      contents: "export default 42",
      loader: "js"
    });
    transaction.phase = "emit";

    expect(() =>
      observeLoad(
        transaction,
        {
          ...args,
          ...(changed === "namespace"
            ? { namespace: "virtual" }
            : changed === "suffix"
              ? { suffix: "?raw" }
              : {})
        },
        {
          contents: "export default 42",
          loader: changed === "loader" ? "text" : "js"
        }
      )
    ).toThrow("changed between passes");
  }
);

it("uses the longest configured loader extension", () => {
  expect(
    effectiveLoader("entry.custom.ts", { ".ts": "ts", ".custom.ts": "jsx" })
  ).toBe("jsx");
});

it("recognizes native text and CSS module defaults", () => {
  expect(effectiveLoader("entry.module.css", undefined)).toBe("local-css");
  expect(effectiveLoader("entry.css", undefined)).toBe("css");
  expect(effectiveLoader("entry.txt", undefined)).toBe("text");
  expect(effectiveLoader("entry.module.css", { ".css": "text" })).toBe(
    "local-css"
  );
  expect(effectiveLoader("entry.module.css", { ".module.css": "text" })).toBe(
    "text"
  );
});

it("unions multiple extracted graphs for one source independent of completion order", () => {
  const transaction = (): BuildTransaction => ({
    phase: "analyze",
    snapshot: new BuildInputSnapshot(),
    graphs: new Map(),
    styles: new Map()
  });

  const a = {
    packages: [{ packageName: "a", firstSeen: 0 }],
    dependencies: [],
    localPackages: []
  };

  const b = {
    packages: [{ packageName: "b", firstSeen: 0 }],
    dependencies: [],
    localPackages: []
  };

  const first = transaction();
  const second = transaction();
  recordPackageGraph(first, "/owner.ts", "b", b);
  recordPackageGraph(first, "/owner.ts", "a", a);
  recordPackageGraph(second, "/owner.ts", "a", a);
  recordPackageGraph(second, "/owner.ts", "b", b);

  expect(first.graphs.get("/owner.ts")).toEqual(second.graphs.get("/owner.ts"));
  expect(
    first.graphs.get("/owner.ts")!.packages.map((entry) => entry.packageName)
  ).toEqual(["a", "b"]);
});
