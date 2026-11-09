// SPDX-License-Identifier: LGPL-2.0-or-later
// Adapted from sequoia-pgp/fast-forward v1.0.0. See README.md and LICENSE.txt.
// Modified by Mincho contributors on 2026-11-10: isolate Git and scope credentials.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function withGitRepository({ remoteUrl, token }, callback) {
  const directory = mkdtempSync(join(tmpdir(), "mincho-fast-forward-"));
  const auth = Buffer.from(`x-access-token:${token}`).toString("base64");
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `http.${remoteUrl}.extraheader`,
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${auth}`
  };
  const git = (...args) =>
    execFileSync("git", args, {
      cwd: directory,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000
    }).trim();
  try {
    git("-c", "init.templateDir=", "init", "--quiet");
    git("remote", "add", "origin", remoteUrl);
    return await callback({
      inspect(pr) {
        git("check-ref-format", `refs/heads/${pr.base.ref}`);
        git(
          "fetch",
          "--quiet",
          "--no-tags",
          "origin",
          `+refs/heads/${pr.base.ref}:refs/remotes/origin/base`,
          `+refs/pull/${pr.number}/head:refs/remotes/origin/pull`
        );
        const base = git("rev-parse", "refs/remotes/origin/base");
        const head = git("rev-parse", "refs/remotes/origin/pull");
        if (head !== pr.head.sha) {
          throw new Error(
            "The PR head changed while fetching; retry the check."
          );
        }
        let possible;
        try {
          git("merge-base", "--is-ancestor", base, head);
          possible = true;
        } catch (error) {
          if (error.status !== 1) throw error;
          possible = false;
        }
        return { base, head, possible };
      },
      push(head, baseRef) {
        // A normal push lets the server enforce ancestry and branch protection.
        git("push", "origin", `${head}:refs/heads/${baseRef}`);
      }
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
