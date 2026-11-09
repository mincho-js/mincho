import assert from "node:assert/strict";
import { test } from "node:test";
import { CHECK_MARKER, MERGE_MARKER } from "./github.js";
import { runAction } from "./run.js";

function fixture({
  merge = false,
  possible = true,
  permitted = true,
  comment = "always",
  refresh
} = {}) {
  const pr = {
    number: 42,
    state: "open",
    base: { ref: "main" },
    head: { ref: "feature", sha: "head" }
  };
  const calls = [];
  let reads = 0;
  let opens = 0;
  let pushes = 0;
  const api = async (path, options = {}) => {
    calls.push({ path, ...options });
    if (path.endsWith("/pulls/42")) {
      reads++;
      return reads === 1 ? pr : (refresh ?? pr);
    }
    if (path.endsWith("/permission"))
      return { user: { permissions: { push: permitted } } };
    if (options.method) return { id: 1, ...options.body };
    return [];
  };
  const input = {
    api,
    repository: "owner/repo",
    number: 42,
    actor: "maintainer",
    merge,
    comment,
    runUrl: "https://github.com/owner/repo/actions/runs/1",
    withRepository: async (callback) => {
      opens++;
      return callback({
        inspect: () => ({ base: "base", head: "head", possible }),
        push: (head, base) => {
          assert.equal(head, "head");
          assert.equal(base, "main");
          pushes++;
        }
      });
    }
  };
  return { input, calls, pr, counts: () => ({ opens, pushes }) };
}

test("a check reports ancestry and never pushes", async () => {
  const state = fixture();
  const result = await runAction(state.input);
  assert.equal(result.success, true);
  assert.equal(result.merged, false);
  assert.equal(state.counts().pushes, 0);
  assert.ok(result.body.startsWith(CHECK_MARKER));
  assert.match(result.body, /Fast-forward is possible/);
});

test("backticks in either ref remain inside Markdown code spans", async () => {
  const state = fixture();
  state.pr.base.ref = "release/``notes";
  state.pr.head.ref = "topic/`@someone`";
  const result = await runAction(state.input);
  assert.equal(result.success, true);
  assert.ok(result.body.includes("Target: ``` release/``notes ``` (base)"));
  assert.ok(result.body.includes("PR head: `` topic/`@someone` `` (head)"));
  const posted = state.calls.find((call) => call.method === "POST");
  assert.equal(posted.body.body, result.body);
});

test("diverged histories fail and publish the failed check", async () => {
  const state = fixture({ possible: false });
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.equal(state.counts().pushes, 0);
  assert.match(result.body, /Rebase the PR/);
  assert.equal(state.calls.filter((c) => c.method === "POST").length, 1);
});

test("merge checks write permission and posts a separate result after pushing", async () => {
  const state = fixture({ merge: true });
  const result = await runAction(state.input);
  assert.equal(result.success, true);
  assert.equal(result.merged, true);
  assert.equal(state.counts().pushes, 1);
  assert.ok(result.body.startsWith(MERGE_MARKER));
  assert.ok(state.calls.some((c) => c.path.endsWith("/maintainer/permission")));
  assert.equal(state.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(
    state.calls.filter((c) => c.path.includes("per_page=")).length,
    0
  );
});

test("a user without push permission cannot fetch or merge", async () => {
  const state = fixture({ merge: true, permitted: false });
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.equal(result.merged, false);
  assert.deepEqual(state.counts(), { opens: 0, pushes: 0 });
});

test("closed PRs and changes to head or target prevent a merge", async () => {
  for (const change of [
    { state: "closed" },
    { head: { ref: "feature", sha: "new-head" } },
    { base: { ref: "release" } }
  ]) {
    const state = fixture({ merge: true });
    const initialApi = state.input.api;
    let reads = 0;
    state.input.api = (path, options) => {
      if (path.endsWith("/pulls/42") && ++reads === 2)
        return { ...state.pr, ...change };
      return initialApi(path, options);
    };
    const result = await runAction(state.input);
    assert.equal(result.success, false);
    assert.equal(state.counts().pushes, 0);
    assert.match(result.body, /PR changed/);
  }
  const state = fixture({ merge: true });
  state.pr.state = "closed";
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.deepEqual(state.counts(), { opens: 0, pushes: 0 });
});

test("Git fetch and push failures fail the action and report the cause", async () => {
  for (const method of ["inspect", "push"]) {
    const state = fixture({ merge: true });
    state.input.withRepository = async (callback) =>
      callback({
        inspect: () => {
          if (method === "inspect") throw new Error("Fetch failed");
          return { base: "base", head: "head", possible: true };
        },
        push: () => {
          throw new Error("Protected branch rejected push");
        }
      });
    const result = await runAction(state.input);
    assert.equal(result.success, false);
    assert.equal(result.merged, false);
    assert.match(
      result.body,
      method === "inspect" ? /Fetch failed/ : /Protected branch/
    );
  }
});

test("never and on-error retain reports without posting successful checks", async () => {
  for (const comment of ["never", "on-error"]) {
    const state = fixture({ comment });
    const result = await runAction(state.input);
    assert.equal(result.success, true);
    assert.ok(result.body.startsWith(CHECK_MARKER));
    assert.equal(
      state.calls.filter((c) => c.path.includes("/comments")).length,
      0
    );
  }
  const state = fixture({ comment: "on-error", possible: false });
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.equal(state.calls.filter((c) => c.method === "POST").length, 1);
});

test("comment errors remain visible even if a push already succeeded", async () => {
  const state = fixture({ merge: true });
  const api = state.input.api;
  state.input.api = (path, options) => {
    if (options?.method === "POST") throw new Error("GitHub failed (503)");
    return api(path, options);
  };
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.equal(result.merged, true);
  assert.match(result.commentError, /503/);
});

test("a cleanup failure cannot leave the action marked successful", async () => {
  const state = fixture({ comment: "on-error" });
  const withRepository = state.input.withRepository;
  state.input.withRepository = async (callback) => {
    await withRepository(callback);
    throw new Error("Unable to clean temporary repository");
  };
  const result = await runAction(state.input);
  assert.equal(result.success, false);
  assert.match(result.body, /Unable to clean/);
  assert.equal(state.calls.filter((c) => c.method === "POST").length, 1);
});
