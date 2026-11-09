import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CHECK_MARKER,
  MERGE_MARKER,
  createApi,
  publishComment
} from "./github.js";

const bot = { login: "github-actions[bot]", type: "Bot" };
const legacy =
  "Checking if we can  fast forward `main`\nTarget branch (`main`):\nPull request (`feature`):";

function store(initial = []) {
  const comments = structuredClone(initial);
  const calls = [];
  const api = async (path, options = {}) => {
    const method = options.method ?? "GET";
    calls.push({ path, method, ...options });
    if (method === "GET") {
      const page = Number(
        new URL(path, "https://api.github.com").searchParams.get("page")
      );
      return comments.slice((page - 1) * 100, page * 100);
    }
    if (method === "POST") {
      const comment = { id: comments.length + 1, user: bot, ...options.body };
      comments.push(comment);
      return comment;
    }
    const comment = comments.find(
      (entry) => entry.id === Number(path.split("/").at(-1))
    );
    Object.assign(comment, options.body);
    return comment;
  };
  return { api, comments, calls };
}

function publish(api, body, merge = false) {
  return publishComment({
    api,
    repository: "owner/repo",
    number: 42,
    body,
    merge
  });
}

test("repeated checks create once and edit the same comment across success and failure", async () => {
  const state = store();
  await publish(state.api, CHECK_MARKER + "\nPossible");
  await publish(state.api, CHECK_MARKER + "\nNeeds rebase");
  await publish(state.api, CHECK_MARKER + "\nPossible again");
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0].body, /Possible again/);
  assert.equal(state.calls.filter((c) => c.method === "POST").length, 1);
  assert.equal(state.calls.filter((c) => c.method === "PATCH").length, 2);
});

test("finds a status on later pages and ignores user markers and merge reports", async () => {
  const comments = Array.from({ length: 100 }, (_, index) => ({
    id: index + 1,
    user: { login: "someone", type: "User" },
    body: CHECK_MARKER + "\nnot the bot"
  }));
  comments.push({ id: 101, user: bot, body: CHECK_MARKER + "\nold status" });
  comments.push({ id: 102, user: bot, body: MERGE_MARKER + "\nmerged" });
  const state = store(comments);
  await publish(state.api, CHECK_MARKER + "\nnew status");
  assert.equal(state.comments.length, 102);
  assert.equal(state.comments[100].body, CHECK_MARKER + "\nnew status");
  assert.equal(state.comments[101].body, MERGE_MARKER + "\nmerged");
  assert.equal(state.comments[0].body, CHECK_MARKER + "\nnot the bot");
  assert.equal(state.calls.filter((c) => c.method === "GET").length, 2);
});

test("adopts the latest upstream check without creating or deleting comments", async () => {
  const state = store([
    { id: 1, user: bot, body: legacy },
    { id: 2, user: bot, body: legacy },
    {
      id: 3,
      user: bot,
      body:
        legacy.replace("Checking if we can", "Trying to") +
        "\nCommit message: checking the report\nChecking if we can  fast forward `main`"
    }
  ]);
  await publish(state.api, CHECK_MARKER + "\nupdated");
  assert.equal(state.comments.length, 3);
  assert.equal(state.comments[0].body, legacy);
  assert.equal(state.comments[1].body, CHECK_MARKER + "\nupdated");
  assert.match(state.comments[2].body, /Trying to/);
});

test("prefers a marked status over a newer legacy comment", async () => {
  const state = store([
    { id: 1, user: bot, body: CHECK_MARKER + "\nold" },
    { id: 2, user: bot, body: legacy }
  ]);
  await publish(state.api, CHECK_MARKER + "\nupdated");
  assert.equal(state.comments[0].body, CHECK_MARKER + "\nupdated");
  assert.equal(state.comments[1].body, legacy);
});

test("never edits another bot's marker or a user's legacy-looking report", async () => {
  const state = store([
    { id: 1, user: { login: "other[bot]", type: "Bot" }, body: CHECK_MARKER },
    { id: 2, user: { login: "someone", type: "User" }, body: legacy }
  ]);
  await publish(state.api, CHECK_MARKER + "\nours");
  assert.equal(state.comments.length, 3);
  assert.equal(state.calls.filter((c) => c.method === "PATCH").length, 0);
});

test("merge reports create a separate comment and leave the check intact", async () => {
  const state = store([{ id: 1, user: bot, body: CHECK_MARKER + "\nready" }]);
  await publish(state.api, MERGE_MARKER + "\nmerged", true);
  assert.equal(state.comments.length, 2);
  assert.equal(state.comments[0].body, CHECK_MARKER + "\nready");
  assert.deepEqual(
    state.calls.map((c) => c.method),
    ["POST"]
  );
});

test("unchanged status does not generate an edit event", async () => {
  const state = store([{ id: 1, user: bot, body: CHECK_MARKER }]);
  await publish(state.api, CHECK_MARKER);
  assert.deepEqual(
    state.calls.map((c) => c.method),
    ["GET"]
  );
});

test("a failed lookup or edit never falls back to creating another comment", async () => {
  for (const failOn of ["GET", "PATCH"]) {
    const state = store([{ id: 1, user: bot, body: CHECK_MARKER }]);
    await assert.rejects(
      publish(async (path, options = {}) => {
        if ((options.method ?? "GET") === failOn)
          throw new Error("API unavailable");
        return state.api(path, options);
      }, CHECK_MARKER + "\nnew"),
      /API unavailable/
    );
    assert.equal(state.comments.length, 1);
    assert.equal(state.calls.filter((c) => c.method === "POST").length, 0);
  }
});

test("GitHub API errors are surfaced without printing credentials", async () => {
  const api = createApi({
    token: "test-secret",
    apiUrl: "https://github.example/api/v3/",
    fetchImpl: async (url, options) => {
      assert.equal(
        url,
        "https://github.example/api/v3/repos/owner/repo/issues/42/comments"
      );
      assert.equal(options.headers.Authorization, "Bearer test-secret");
      assert.equal(options.redirect, "error");
      return new Response("unauthorized", { status: 403 });
    }
  });
  await assert.rejects(api("/repos/owner/repo/issues/42/comments"), (error) => {
    assert.match(error.message, /failed \(403\)/);
    assert.doesNotMatch(error.message, /test-secret/);
    return true;
  });
});
