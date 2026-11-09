# Fast-forward action

Repository-owned adaptation of
[sequoia-pgp/fast-forward v1.0.0](https://github.com/sequoia-pgp/fast-forward/tree/ea7628bedcb0b0b96e94383ada458d812fca4979).
The Node implementation uses only built-in modules. The adapted action remains
licensed under LGPL-2.0-or-later; the upstream license is in [LICENSE.txt](LICENSE.txt).

`merge: false` checks whether the target branch is an ancestor of the PR head.
Checks create a status comment once, then update that bot-authored comment using
`<!-- mincho-fast-forward-check -->`. Comment lookup includes every page and can
adopt the latest check posted by the previous action. Human comments and merge
reports are never edited. Existing duplicate comments are left intact.

`merge: true` checks the requesting user's push permission, refreshes the PR state,
and performs a normal Git push. Divergence, changes to the PR during the check,
and server-side branch protection failures prevent a successful merge. Merge
attempts post a separate result, preserving the check comment. Git uses a temporary
repository, never checks out PR files, and scopes its credential header to the
base repository without writing credentials to disk or changing global config.
Each Git command is limited to two minutes; both workflow jobs are limited to
ten minutes so stalled work cannot indefinitely block later requests for a PR.

Both workflows execute this action from the trusted default branch and share a
per-PR concurrency group. The check uses `pull_request_target` so fork PRs can receive
comments, but it never executes their code. Bot comments cannot trigger the merge
workflow. Action changes take effect in these workflows after reaching the default
branch; CI tests the proposed implementation before then.

Inputs retain the upstream `github_token`, `merge`, and `comment` interface.
`comment` accepts `always`, `on-error`, or `never` (`true`/`false` are aliases).
The JSON `comment` output and step summary are available even when posting is
disabled. `merged` reports whether this execution pushed the target branch.
Failed checks, merges, or comment API requests fail the action.

Run the offline tests with:

```sh
node --test .github/actions/fast-forward/*.test.js
```

Tests use mock GitHub responses and temporary local Git repositories. They never
post GitHub comments or merge a real PR.
