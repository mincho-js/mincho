import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { withGitRepository } from "./git.js";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "fast-forward-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source");
  const remote = join(directory, "remote.git");
  mkdirSync(source);
  const git = (cwd, ...args) =>
    execFileSync("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com"
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  git(directory, "init", "--bare", "--quiet", remote);
  git(source, "init", "--quiet", "--initial-branch=main");
  git(source, "config", "commit.gpgsign", "false");
  function commit(value) {
    writeFileSync(join(source, "file.txt"), value);
    git(source, "add", "file.txt");
    git(source, "commit", "--quiet", "-m", value);
    return git(source, "rev-parse", "HEAD");
  }
  const base = commit("base");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "origin", "main");
  git(source, "switch", "--quiet", "-c", "feature");
  const head = commit("feature");
  git(source, "push", "--quiet", "origin", "HEAD:refs/pull/42/head");
  const pr = {
    number: 42,
    base: { ref: "main" },
    head: { ref: "feature", sha: head }
  };
  return {
    pr,
    base,
    head,
    remote,
    source,
    withRepository: (callback) =>
      withGitRepository(
        { remoteUrl: remote, token: "unused-test-token" },
        callback
      ),
    remoteHead: () =>
      git(directory, "--git-dir", remote, "rev-parse", "refs/heads/main"),
    advanceBase() {
      git(source, "switch", "--quiet", "main");
      const sha = commit("diverged");
      git(source, "push", "--quiet", "origin", "main");
      return sha;
    }
  };
}

test("checks real ancestry and fast-forwards without a merge commit", async (t) => {
  const state = fixture(t);
  await state.withRepository(async (git) => {
    assert.deepEqual(git.inspect(state.pr), {
      base: state.base,
      head: state.head,
      possible: true
    });
    assert.equal(state.remoteHead(), state.base);
    git.push(state.head, "main");
    assert.equal(state.remoteHead(), state.head);
  });
});

test("a target that has diverged is not fast-forwardable", async (t) => {
  const state = fixture(t);
  const advanced = state.advanceBase();
  await state.withRepository(async (git) => {
    assert.deepEqual(git.inspect(state.pr), {
      base: advanced,
      head: state.head,
      possible: false
    });
    assert.equal(state.remoteHead(), advanced);
  });
});

test("an advancing target cannot be overwritten between checking and pushing", async (t) => {
  const state = fixture(t);
  await state.withRepository(async (git) => {
    assert.equal(git.inspect(state.pr).possible, true);
    const advanced = state.advanceBase();
    assert.throws(() => git.push(state.head, "main"));
    assert.equal(state.remoteHead(), advanced);
  });
});

test("a server rejection is surfaced and preserves the target branch", async (t) => {
  const state = fixture(t);
  await state.withRepository(async (git) => {
    assert.equal(git.inspect(state.pr).possible, true);
    writeFileSync(
      join(state.remote, "hooks", "pre-receive"),
      "#!/bin/sh\nexit 1\n",
      { mode: 0o755 }
    );
    assert.throws(() => git.push(state.head, "main"));
    assert.equal(state.remoteHead(), state.base);
  });
});

test("a stale PR head is rejected instead of reporting the wrong commit", async (t) => {
  const state = fixture(t);
  await state.withRepository(async (git) => {
    assert.throws(
      () =>
        git.inspect({
          ...state.pr,
          head: { ...state.pr.head, sha: state.base }
        }),
      /head changed while fetching/
    );
    assert.equal(state.remoteHead(), state.base);
  });
});
