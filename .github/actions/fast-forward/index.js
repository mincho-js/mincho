// SPDX-License-Identifier: LGPL-2.0-or-later
// Adapted from sequoia-pgp/fast-forward v1.0.0. See README.md and LICENSE.txt.
// Modified by Mincho contributors on 2026-11-10: Node action entry point.

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createApi } from "./github.js";
import { withGitRepository } from "./git.js";
import { runAction } from "./run.js";

try {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const number = event.pull_request?.number ?? event.issue?.number;
  const repository = process.env.GITHUB_REPOSITORY;
  const token = process.env.INPUT_GITHUB_TOKEN;
  if (
    !Number.isSafeInteger(number) ||
    number < 1 ||
    (!event.pull_request && !event.issue?.pull_request)
  ) {
    throw new Error("A pull request event is required.");
  }
  if (!repository || !/^[\w.-]+\/[\w.-]+$/.test(repository) || !token) {
    throw new Error("GITHUB_REPOSITORY and github_token are required.");
  }
  const mergeInput = process.env.INPUT_MERGE ?? "false";
  if (!["true", "false"].includes(mergeInput))
    throw new Error("merge must be true or false.");
  const policy = process.env.INPUT_COMMENT ?? "on-error";
  const comment = { true: "always", false: "never" }[policy] ?? policy;
  if (!["always", "on-error", "never"].includes(comment))
    throw new Error("Invalid comment policy.");
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const api = createApi({
    token,
    apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com"
  });
  const result = await runAction({
    api,
    repository,
    number,
    actor: event.sender?.login ?? process.env.GITHUB_ACTOR,
    merge: mergeInput === "true",
    comment,
    runUrl: `${server}/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}`,
    withRepository: (callback) =>
      withGitRepository(
        { remoteUrl: `${server}/${repository}.git`, token },
        callback
      )
  });
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.body + "\n");
  const delimiter = `comment_${randomUUID()}`;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `comment<<${delimiter}\n${JSON.stringify({ body: result.body })}\n${delimiter}\nmerged=${result.merged}\n`
  );
  if (result.commentError)
    console.error(`Unable to publish the report: ${result.commentError}`);
  if (!result.success) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
