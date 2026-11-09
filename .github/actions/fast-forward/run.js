// SPDX-License-Identifier: LGPL-2.0-or-later
// Adapted from sequoia-pgp/fast-forward v1.0.0. See README.md and LICENSE.txt.
// Modified by Mincho contributors on 2026-11-10: refresh PR state before merging.

import { CHECK_MARKER, MERGE_MARKER, publishComment } from "./github.js";

function formatRef(ref) {
  const runs = ref.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  return `${fence} ${ref} ${fence}`;
}

export async function runAction({
  api,
  repository,
  number,
  actor,
  merge,
  comment,
  runUrl,
  withRepository
}) {
  const prPath = `/repos/${repository}/pulls/${number}`;
  const lines = [
    merge ? MERGE_MARKER : CHECK_MARKER,
    `### Fast-forward ${merge ? "merge" : "check"}`,
    ""
  ];
  let success = false;
  let merged = false;
  try {
    const pr = await api(prPath);
    if (pr.state !== "open") throw new Error("This pull request is not open.");
    if (merge) {
      const permissions = await api(
        `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`
      );
      if (permissions.user?.permissions?.push !== true) {
        throw new Error(
          `@${actor} does not have permission to push to this repository.`
        );
      }
    }
    await withRepository(async (git) => {
      const { base, head, possible } = git.inspect(pr);
      lines.push(
        `Target: ${formatRef(pr.base.ref)} (${base})`,
        `PR head: ${formatRef(pr.head.ref)} (${head})`,
        ""
      );
      if (!possible) {
        throw new Error(
          "The target branch is not an ancestor of this PR. Rebase the PR before merging."
        );
      }
      const current = await api(prPath);
      if (
        current.state !== "open" ||
        current.head.sha !== head ||
        current.base.ref !== pr.base.ref
      ) {
        throw new Error(
          "The PR changed during this check; retry with its current state."
        );
      }
      if (merge) {
        git.push(head, pr.base.ref);
        merged = true;
        lines.push("Successfully fast-forwarded the target branch.");
      } else {
        lines.push(
          "Fast-forward is possible. A user with write access can comment `/fast-forward` to merge."
        );
      }
      success = true;
    });
  } catch (error) {
    success = false;
    lines.push(
      `Fast-forward ${merge ? "merge" : "check"} failed: ${error.message}`
    );
  }
  lines.push("", `[Workflow run](${runUrl})`);
  const body = lines.join("\n");
  let commentError;
  if (comment === "always" || (comment === "on-error" && !success)) {
    try {
      await publishComment({ api, repository, number, body, merge });
    } catch (error) {
      success = false;
      commentError = error.message;
    }
  }
  return { success, merged, body, commentError };
}
