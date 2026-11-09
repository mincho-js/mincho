// SPDX-License-Identifier: LGPL-2.0-or-later
// Adapted from sequoia-pgp/fast-forward v1.0.0. See README.md and LICENSE.txt.
// Modified by Mincho contributors on 2026-11-10: reuse paginated check comments.

export const CHECK_MARKER = "<!-- mincho-fast-forward-check -->";
export const MERGE_MARKER = "<!-- mincho-fast-forward-merge -->";

export function createApi({ token, apiUrl, fetchImpl = fetch }) {
  return async (path, { method = "GET", body } = {}) => {
    const response = await fetchImpl(`${apiUrl.replace(/\/$/, "")}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
    }
    return response.status === 204 ? null : response.json();
  };
}

function isCheckComment(comment) {
  if (
    comment.user?.type !== "Bot" ||
    comment.user.login !== "github-actions[bot]"
  ) {
    return false;
  }
  const body = comment.body ?? "";
  const targetHeading = body.indexOf("\nTarget branch (`");
  const legacyHeader = targetHeading < 0 ? "" : body.slice(0, targetHeading);
  return (
    body.startsWith(CHECK_MARKER) ||
    // Adopt the most recent check from the previous upstream action, too.
    // Inspect the report header, never arbitrary commit messages in its Git log.
    (/^Checking if we can +fast forward `/m.test(legacyHeader) &&
      body.includes("Pull request (`") &&
      !body.startsWith(MERGE_MARKER))
  );
}

export async function publishComment({ api, repository, number, body, merge }) {
  const commentsPath = `/repos/${repository}/issues/${number}/comments`;
  if (merge) return api(commentsPath, { method: "POST", body: { body } });

  const candidates = [];
  for (let page = 1; ; page++) {
    const comments = await api(`${commentsPath}?per_page=100&page=${page}`);
    candidates.push(...comments.filter(isCheckComment));
    if (comments.length < 100) break;
  }
  // Prefer our stable marker over legacy checks, regardless of page ordering.
  const marked = candidates.filter((comment) =>
    comment.body.startsWith(CHECK_MARKER)
  );
  const existing = (marked.length ? marked : candidates).reduce(
    (latest, comment) => (!latest || comment.id > latest.id ? comment : latest),
    null
  );
  if (existing) {
    if (existing.body === body) return existing;
    return api(`/repos/${repository}/issues/comments/${existing.id}`, {
      method: "PATCH",
      body: { body }
    });
  }
  return api(commentsPath, { method: "POST", body: { body } });
}
