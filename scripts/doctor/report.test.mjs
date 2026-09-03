import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDecision, reviewDoctor } from "./report.mjs";

const source = 'import type { MDXComponents } from "mdx/types";';
const exception = {
  id: "mdx-type-import",
  file: "site/mdx-components.tsx",
  type: "error",
  message: "Undeclared dependency on mdx",
  source,
  count: 1,
  reason: "Type-only import is provided by the declared @types/mdx dependency"
};
const diagnostic = {
  type: "error",
  data: "/repo/site/mdx-components.tsx:1:1: Undeclared dependency on mdx"
};
const summary = { type: "summary", workspaces: 2, files: 10 };
function review(events = [diagnostic, summary], overrides = {}) {
  return reviewDoctor({
    stdout: events.map((event) => JSON.stringify(event)).join("\n"),
    status: 1,
    signal: null,
    root: "/repo",
    exceptions: [exception],
    readSource: () => source,
    today: "2026-10-01",
    ...overrides
  });
}

test("accepts an exact documented exception and a complete scan", () => {
  const result = review();
  assert.deepEqual(result.failures, []);
  assert.equal(result.accepted, 1);
});

test("line shifts preserve an exception when the source is unchanged", () => {
  const moved = {
    ...diagnostic,
    data: diagnostic.data.replace(":1:1:", ":2:1:")
  };
  assert.deepEqual(
    review([moved, summary], { readSource: () => `\n${source}` }).failures,
    []
  );
});

for (const code of ["ENOENT", "EACCES"]) {
  test(`source read failures (${code}) are NEW and do not stop the report`, () => {
    const missingFile = "site/unreadable.tsx";
    const unreadable = {
      ...diagnostic,
      data: diagnostic.data.replace(exception.file, missingFile)
    };
    const result = review([unreadable, diagnostic, summary], {
      exceptions: [
        exception,
        { ...exception, id: "unreadable-source", file: missingFile }
      ],
      readSource: (file) => {
        if (file === missingFile) {
          throw Object.assign(new Error("Cannot read source"), { code });
        }
        return source;
      }
    });
    assert.deepEqual(
      result.decisions.map((decision) => decision.kind),
      ["NEW", "ALLOW", "STALE"]
    );
    assert.match(result.decisions[0].message, /site\/unreadable\.tsx:1:/);
    assert.equal(result.decisions[1].id, exception.id);
    assert.equal(result.decisions[2].id, "unreadable-source");
    assert.equal(result.accepted, 1);
    assert.equal(result.failures.length, 2);
    assert.deepEqual(result.summary, summary);
  });
}

test("does not exempt a new undeclared import in the same file", () => {
  const unexpected = {
    ...diagnostic,
    data: diagnostic.data.replace(/mdx$/, "missing-package")
  };
  assert.ok(
    review([diagnostic, unexpected, summary]).failures.some((failure) =>
      failure.includes("missing-package")
    )
  );
});

test("turning a type-only import into a runtime import invalidates its exception", () => {
  assert.ok(
    review(undefined, {
      readSource: () => source.replace("import type", "import")
    }).failures.length
  );
});

test("a repeated diagnostic cannot reuse a single-occurrence exception", () => {
  assert.ok(
    review([diagnostic, diagnostic, summary]).failures.some((failure) =>
      failure.includes("received 2")
    )
  );
});

test("unused exceptions fail instead of silently accumulating", () => {
  assert.ok(
    review([summary], { status: 0 }).failures.some((failure) =>
      failure.includes("received 0")
    )
  );
});

test("new resolver warnings fail even if Doctor exits zero", () => {
  const warning = { type: "warning", data: "Resolving a dependency failed" };
  assert.ok(
    review([warning, summary], { status: 0, exceptions: [] }).failures.some(
      (failure) => failure.includes(warning.data)
    )
  );
});

test("truncated or non-JSON output fails", () => {
  assert.throws(() => review(undefined, { stdout: '{"type":' }));
  assert.throws(() => review(undefined, { stdout: "Doctor crashed" }));
});

test("an incomplete or empty scan cannot pass on exceptions alone", () => {
  assert.ok(review([diagnostic]).failures.length);
  assert.ok(review([diagnostic, { ...summary, files: 0 }]).failures.length);
  assert.ok(review([summary, diagnostic]).failures.length);
});

test("unexpected exits, signals and inconsistent error counts fail", () => {
  assert.ok(review(undefined, { status: 2 }).failures.length);
  assert.ok(
    review(undefined, { status: null, signal: "SIGTERM" }).failures.length
  );
  assert.ok(review(undefined, { status: 0 }).failures.length);
  assert.ok(review([summary], { status: 1, exceptions: [] }).failures.length);
});

test("exceptions require a reason, a bounded count, and a repository path", () => {
  for (const invalid of [
    { id: "" },
    { id: "invalid id" },
    { reason: "" },
    { count: 0 },
    { file: "../outside.ts" }
  ]) {
    assert.throws(() =>
      review(undefined, { exceptions: [{ ...exception, ...invalid }] })
    );
  }
  assert.throws(() =>
    review(undefined, { exceptions: [exception, exception] })
  );
});

test("reports allowed and unexpected diagnostics with explicit labels and IDs", () => {
  const allowed = review().decisions.find(
    (decision) => decision.kind === "ALLOW"
  );
  assert.equal(allowed.id, exception.id);
  assert.match(
    formatDecision(allowed),
    /^ALLOW \[mdx-type-import\] site\/mdx-components.tsx:1:/
  );
  const unknown = {
    ...diagnostic,
    data: diagnostic.data.replace(/mdx$/, "missing")
  };
  assert.ok(
    review([diagnostic, unknown, summary]).decisions.some(
      (decision) => decision.kind === "NEW"
    )
  );
});

test("IDs are unique even when rules match different sources", () => {
  assert.throws(
    () =>
      review(undefined, {
        exceptions: [exception, { ...exception, source: "different source" }]
      }),
    /Duplicate Doctor exception id/
  );
});

test("different IDs cannot overlap on the same exact diagnostic", () => {
  assert.throws(
    () =>
      review(undefined, {
        exceptions: [exception, { ...exception, id: "another-mdx-rule" }]
      }),
    { code: "AMBIGUOUS" }
  );
});

test("expiry dates are inclusive and compared using the UTC review date", () => {
  const exceptions = [{ ...exception, expires: "2026-12-31" }];
  for (const today of ["2026-12-30", "2026-12-31"]) {
    assert.deepEqual(review(undefined, { exceptions, today }).failures, []);
  }
  const expired = review(undefined, { exceptions, today: "2027-01-01" });
  assert.equal(expired.accepted, 0);
  assert.ok(
    expired.decisions.some(
      (decision) => decision.kind === "EXPIRED" && decision.id === exception.id
    )
  );
  assert.ok(expired.decisions.some((decision) => decision.kind === "NEW"));
});

test("expired rules fail even if no diagnostic matches them", () => {
  const result = review([summary], {
    status: 0,
    exceptions: [{ ...exception, expires: "2026-09-30" }]
  });
  assert.equal(result.failures.length, 1);
  assert.equal(result.decisions[0].kind, "EXPIRED");
});

test("expiry validation rejects malformed and impossible calendar dates", () => {
  for (const expires of [
    "2026-02-29",
    "2026-02-30",
    "2026-13-01",
    "2026-1-01",
    "soon",
    17
  ]) {
    assert.throws(
      () => review(undefined, { exceptions: [{ ...exception, expires }] }),
      /invalid expires date/
    );
  }
  assert.deepEqual(
    review(undefined, {
      exceptions: [{ ...exception, expires: "2028-02-29" }]
    }).failures,
    []
  );
  assert.deepEqual(
    review(undefined, {
      exceptions: [{ ...exception, expires: null }]
    }).failures,
    []
  );
});

test("both unused and partially used rules are STALE, excess matches are BROAD", () => {
  assert.ok(
    review([summary], { status: 0 }).decisions.some(
      (decision) => decision.kind === "STALE"
    )
  );
  assert.ok(
    review(undefined, {
      exceptions: [{ ...exception, count: 2 }]
    }).decisions.some((decision) => decision.kind === "STALE")
  );
  assert.ok(
    review([diagnostic, diagnostic, summary]).decisions.some(
      (decision) => decision.kind === "BROAD"
    )
  );
});

test("process failures and incomplete scans are labeled ERROR", () => {
  assert.ok(
    review([diagnostic]).decisions.some((decision) => decision.kind === "ERROR")
  );
  assert.ok(
    review(undefined, { status: null, signal: "SIGTERM" }).decisions.some(
      (decision) => decision.kind === "ERROR"
    )
  );
});
