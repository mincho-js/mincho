# Contributing

<!-- markdown-toc start - Don't edit this section. Run M-x markdown-toc-refresh-toc -->
**Table of Contents**

- [Contributing](#contributing)
    - [Introduce](#introduce)
        - [Code of Conduct](#code-of-conduct)
        - [We Develop with Github](#we-develop-with-github)
        - [Your First Contribution](#your-first-contribution)
        - [Contribution Targets](#contribution-targets)
    - [Development](#development)
        - [Environment](#environment)
        - [Working process](#working-process)
            - [Adding a new feature](#adding-a-new-feature)
            - [Fixing bugs](#fixing-bugs)
        - [Rules](#rules)
            - [Basics](#basics)
            - [Commits](#commits)
            - [PR](#pr)
    - [License](#license)
    - [References](#references)

<!-- markdown-toc end -->

## Introduce

I'm really glad you're reading this, because we need volunteer developers to help this project come to fruition.

This document is intended for onboarding and is intended to clarify as much as possible.

You can use it as a reference for various guidelines and information, and PR comfortably.

Please note we have a code of conduct, please follow it in all your interactions with the project.

### Code of Conduct

Refer to [CODE\_OF\_CONDUCT.md](./CODE_OF_CONDUCT.md).

### We Develop with Github

We use [github](https://github.com/mincho-js/mincho) to host code, to track [issues](https://github.com/mincho-js/mincho/issues) and [feature requests](https://github.com/mincho-js/working-group), as well as accept [pull requests](https://github.com/mincho-js/mincho/pull).

After feedback has been given we expect responses within two weeks. After two weeks we may close the issue and pull request if it isn't showing any activity.

### Your First Contribution

**Working on your first Pull Request?**

You can learn how from this *free* series [How to Contribute to an Open Source Project on GitHub](https://egghead.io/series/how-to-contribute-to-an-open-source-project-on-github)

And, Please refer to the [development documentation](#development).

### Contribution Targets

We love your input! We want to make contributing to this project as easy and transparent as possible, whether it's:

**Codes**
- New Features.
- Bug fixes.
- Improved compatibility or accessibility.
- Refactoring.

**Website**
- We don't have the resources to create a website ourselves at this time.
- Contributions are welcome.

**Graphic Resources**
- Banner && Social preview image

**Issues**
- Report a bug.
- Discussing the current state of the code.
- Tell us about related or relevant projects and documents.
- Help other users issue.
- Proposing others..

**Documents**
- Suggestion RFC.
- Fix typos, alignments.
- Correct awkward sentences.
- Improve document readability.

**Promotions**
- Introduce project
  - Video
  - Blog
  - SNS
  - Reddit, Hackernews..etc

## Development

> [!IMPORTANT]
> 1. Enable the corepack, and run `yarn build` after `yarn install`.
> 2. Commits should be small (200-300 lines), linear history.
> 3. If you're planning to develop a large feature, write an RFC in a [working group](https://github.com/mincho-js/working-group) first.

### Environment

1. [`git`](https://git-scm.com/downloads) and [`node`](https://nodejs.org/en/download) must be installed.
2. Enable [corepack](https://github.com/nodejs/corepack). On Windows, run the [Powershell as administrator](https://github.com/nodejs/corepack/issues/71).
```shell
corepack enable
```
3. [Fork the project](https://github.com/mincho-js/mincho/fork) and download it.
```shell
# Downloading repo
git clone https://github.com/<your-fork>/mincho.git

# Entering a directory
cd mincho
```
4. Install the package, and **build it once**.  
   If you don't build it, you might get errors for packages that depend on the build results of internal packages.
```shell
# Installing packages
yarn install

# Build (important!!)
yarn build
```

### Working process

We work in an [RFC](https://en.wikipedia.org/wiki/Request_for_Comments) - [TDD](https://en.wikipedia.org/wiki/Test-driven_development) way.
- RFC: Requirement Analysis - Design
- TDD: Development - Testing

This is to ensure reliability while sharing as much context as possible.  
We also offer a range of handy tools to help you focus on design/implementation.

#### Adding a new feature

If possible, it's a good idea to write an RFC first.
1. Create an RFC document in a [working group](https://github.com/mincho-js/working-group) and get it approved.
2. View RFCs and add in source test cases
3. If the implementation requires further design, you can write it up in an RFC, PR it, and commit it. (You can do this at any time.)
4. Make only that test run with `it.only()`, and run in debugger mode
5. Add breakpoint where there's doubt, and add log if necessary
6. Coding the implementation...
7. Turn off the `it.only()` option, and when you return, run the full test with `yarn test:all` command

#### Fixing bugs

You don't need to write an RFC first, but if you need to make a design change to fix a bug, write an RFC.
1. Add in source test cases
2. Make only that test run with `it.only()`, and run in debugger mode
3. Add breakpoint where there's doubt, and add log if necessary
4. Coding the implementation...
5. Turn off the `it.only()` option, and when you return, run the full test with `yarn test:all` command

#### Debugger & debugLog Video

Here's a [simple video](/assets/debug-log.mp4) using debugger and `debugLog`.

https://github.com/user-attachments/assets/cd325adf-9ed4-46e9-b7db-8688bd9f84bf

### Rules
#### Basics

**Version**

Milestone, The versioning scheme we use is [SemVer](https://semver.org/).

We will release the feature as soon as it is complete, but the cycle should be 2-4 weeks. Rapid releases.

**Issue**

Search:
- Search the project’s [issues](https://github.com/mincho-js/mincho/issues?q=sort%3Aupdated-desc+is%3Aissue+is%3Aopen+) to make sure it's not a known issue.

Versions:
- Make sure you’re on the latest version.
- Try older versions.
- Try switching up dependency versions.

Reproduction:
- It should be reproducible, especially if it's a bug.
- If you can provide a reproducible repo, that's great.

#### Commits

**Principles**
- **Meaningfully:** It doesn't make meaningless commits.
- **One per task:** It's difficult to distinguish when various tasks are mixed.
  - A one- or two-line commit is fine, as long as it makes sense.
  - Doing one per task makes [revert](https://git-scm.com/docs/git-revert) possible
- **Often:** Large-scale changes leave more room for things to go wrong in the code and make it harder to review.
  - To be reviewed within an hour, it should be [inside 200 lines](https://smallbusinessprogramming.com/optimal-pull-request-size/).
  - Unless there are special circumstances, try to stay within 300-400 lines per commit. Anything larger than 500 lines becomes [nearly impossible to review](https://smartbear.com/learn/code-review/best-practices-for-peer-code-review/).
- **Linear log**: Merge commits are difficult to manage and track. **This is a very enforced rule**

**Recommended Git settings**

> [!TIP]
> We recommend [edamagit](https://github.com/kahole/edamagit) as a git client for Visual studio code and [git-branchless](https://github.com/arxanas/git-branchless) as a tool for linear history.

Here are the Git settings that our team recommends.

For convenience, we've used the global setting of `--global`, but if you want to make settings only in this project, you can do so by entering the cloned project location in the terminal.

First, align line endings between Windows, Mac, and Linux.

Windows:
```shell
git config --global core.autocrlf true
```

Mac / Linux:
```shell
git config --global core.autocrlf input
```

The rest of the settings are shared.
```shell
## Fix git status broken with CJK
git config --global core.quotepath false

## Branch command sort
git config --global branch.sort -committerdate

## Push the branch to a remote with the same name
git config --global push.autosetupremote true

## Safe push (Verify last push matches server before branch update)
git config --global alias.fpush push --force-with-lease

## Always pull with rebase
git config --global pull.rebase true

## Auto stash before, pop after
git config --global rebase.autostash true

## Memorizes the conflict and the resolution
git config --global rerere.enabled true
git config --global rerere.autoUpdate true

## Better diff algorithm
## https://luppeng.wordpress.com/2020/10/10/when-to-use-each-of-the-git-diff-algorithms/
git config --global diff.algorithm histogram

## Avoid data corruption
git config --global transfer.fsckobjects true
git config --global fetch.fsckobjects true
git config --global receive.fsckObjects true
```

**Commit Message**
- If an issue exists, you should include the issue number in the commit message.
- Make it easy to understand at a glance.
  - If you need to include additional information, use the commit message body.
- Keep commit messages as consistent as possible.
  - `Type: Message Type`: Make sure to specify the type.
  - `Type: Component - Message format`: You can also include component information like [Linux](https://github.com/torvalds/linux) does.

These are the types of commit messages we use.
- `Fix`: Bug fix
- `Feat`: Add feature
- `Docs`: Documents
- `Style`: Code style
- `Refactor`: Refactoring
- `Perf`: Improving performance
- `Test`: Test code
- `Chore`: Build process, libraries, and tooling
- `Bump`: Updating dependencies

#### PR

**Basics**
- Branch: Create a new branch rather than committing directly to `main`.
- Issue:  We recommend that you open the issue first to discuss the changes with the stakeholders of this repository.
- Test: Please check if it was `yarn test:all` before PR.

**Stacked PR**
Use [Stacked PR](https://timothya.com/blog/git-stack/) for short reviews and linear record keeping.
- If a commit has a weak dependency, think of #1 #2 #3 being [merged sequentially](https://newsletter.pragmaticengineer.com/p/stacked-diffs).
- If a commit has a strong dependency, think of #1 #2 #3 being [merged in reverse order](https://www.michaelagreiler.com/stacked-pull-requests/).
- If you use [git-branchless](https://github.com/arxanas/git-branchless), you can easily rebase with the [`git sync --pull`](https://github.com/arxanas/git-branchless/wiki/Command:-git-sync#fetching-remote-references) command. After that, do `git push -f origin <your-branch>`.

**Review**

> [!NOTE]
> Due to the current staff shortage, we are using AI automation to perform the first round of code reviews.

- If possible, we should have more than one reviewer.
- Provide a good explanation of why the improvement is needed.
- Help guide us to keep our code clean and implement it consistently.
- If you have history, you should share it.
- We have [feedback ladders like netlify](https://www.netlify.com/blog/2020/03/05/feedback-ladders-how-we-encode-code-reviews-at-netlify/).
  - `P0`[Critical defects]: There is a serious issue that requires further review and cannot be merged in its current state.
    - Use `Request changes` or `Close`
    - PR Description and RFC are not sufficiently descriptive
    - Change size is too large
    - Poorly designed and needs to be reworked from scratch
    - Serious security vulnerabilities or licence violations
    - Doesn't fit with the direction the project is going
  - `P1`[Required changes]: It must be corrected and will not be approved without it.
    - Use `Request changes`
    - Fails to pass CI
    - Breaking a rule in this document
    - Incorrect implementation of RFC
    - Missing edge cases in test code
    - Sensitive information hardcoded into your code (API keys, passwords, etc.)
  - `P2`[Strongly Recommended]: Please actively consider it. Changes are strongly encouraged, and if you don't make a change, you need a good reason.
    - USe `Request changes`
    - Needs performance optimisation
    - Consistency in code
    - From here, if you disagree with the reviewer, discuss it.
  - `P3`[Recommendations]: If you can, please do so. We encourage changes, but it's up to the developer to decide.
    - Use `Comment`
    - Questions should be answered for review
    - Missing comments for complex logic
    - Functions that are too long (50 lines less is recommended)
    - Finding unnecessary code
  - `P4`[Optional suggestions]: You can take it on board or move on. This is a suggestion that is at the developer's discretion.
    - Use `Approve`
    - Fix ambiguous variable names
    - Suggest a different algorithm or approach
    - Writing unit tests for better test coverage
    - Opinions based on reviewer preferences
  - `P5`[Note comments]: These are simply comments or suggestions, and it's up to the developer to decide whether or not to implement them.
    - Use `Approve`
    - Notes for history
    - Not sure if it's better, but here's a suggestion
    - Listing information references

## License

**Any contributions you make will be under the MIT License**

In short, when you submit code changes, your submissions are understood to be under the same [MIT License](https://choosealicense.com/licenses/mit/) that covers the project.
Feel free to contact the maintainers if that's a concern.

**Reference specification**

Even if you copy the code snippet, it is recommended that you leave a link.

**FAQ**

If you need an interpretation of the licence, please see [The MIT License, Line by Line](https://writing.kemitchell.com/2016/09/21/MIT-License-Line-by-Line.html).

## References

- [Good-CONTRIBUTING.md-template](https://gist.github.com/PurpleBooth/b24679402957c63ec426)
- [Contributing to Transcriptase](https://gist.github.com/briandk/3d2e8b3ec8daf5a27a62)
- [contributing-template](https://github.com/nayafia/contributing-template/blob/master/CONTRIBUTING-template.md)
- [Contributing to Open Source Projects](https://www.contribution-guide.org/)
