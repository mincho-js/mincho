# Mincho documentation site

The site uses Next.js App Router, Nextra, and Lingui. It exports static HTML for
GitHub Pages at `/mincho`.

English is the default language: `/` and `/docs/*`. Korean pages are at `/ko` and
`/ko/docs/*`. There is no browser-language redirect or server middleware, so the
same routes work on a static host. The language selector preserves the current
document, query string, and heading anchor.

## Development and validation

Use the Node and Yarn versions in the repository's `mise.toml`:

```sh
mise exec -- yarn install --immutable
mise exec -- yarn workspace mincho-docs dev
mise exec -- yarn workspace mincho-docs build
mise exec -- yarn workspace mincho-docs check
mise exec -- yarn workspace mincho-docs test
```

`build` compiles the landing-page demo and Lingui catalogs, exports both languages, and generates Pagefind
search indexes in `out/_pagefind`. `test` checks the exported HTML, locale-specific
links, shared anchors, unchanged code examples, and both search indexes. Run it
after `build`. To preview production, serve `out` at `/mincho/` on a static HTTP
server; Next.js `start` does not serve static exports.

For live updates at `http://127.0.0.1:34805/mincho/`, run
`mise exec -- yarn workspace mincho-docs dev --hostname 127.0.0.1 --port 34805`.
A static server serving `out` only reflects changes after another build.
Development uses Webpack to avoid Rspack's heap exhaustion when compiling
documentation routes in this Yarn PnP workspace. Production exports use Rspack.
Documentation commit dates are shown in production exports; development omits
Nextra's temporary compilation timestamps.

## Landing page

The typography uses the Pretendard variable dynamic subset from the pinned npm
package. Rspack emits its font files as local static assets, and browsers request
only the Unicode ranges they need. No font CDN is needed at runtime.
Code blocks, inline code, and terminal examples use Geist Mono, bundled locally
through `geist/font/mono` and `next/font/local`.
`public/logo.svg` is a vector adaptation of the official mascot in
[`assets/logo.png`](../assets/logo.png).
The favicon uses the mascot's face to remain recognizable at small sizes. SVG,
multi-resolution ICO, and Apple touch icons share the `/mincho/` asset paths
across both languages.

The example files in `examples/workflow/` are both the code shown on the
landing page and the source of its interactive button. They connect `theme()`
tokens to `defineRules()`, create variants with its scoped `rules()`, and compose
the resulting classes with its `cx()` in a React component.
The definition and recipe steps show consecutive parts of `button.css.ts`.
Keep authoring factories local to that file and export only the recipe and `cx`,
so the demo bundle contains the compiled runtime helpers rather than the style compiler.

`demo:build` builds the local Mincho compiler dependencies and uses the esbuild
integration to emit `src/generated/workflow.mjs` and `workflow.css`. Both are
ignored build outputs; the declaration file stays in source control. The
explicit `@mincho-js/transform-to-vanilla` development dependency allows the
compiler's external style evaluator to resolve that package under Yarn PnP.
Development and production commands build the demo automatically. After editing
an example during development, run `yarn workspace mincho-docs demo:build` again
so the preview matches the displayed source. `test` validates the generated
themes, variants, class composition, and absence of runtime CSS injection.

## UI translations

Lingui manages homepage, metadata, language selector, and configurable Nextra UI
messages. Add English messages using `i18n._({ id, message })` inside components:

```tsx
i18n._({ id: "home.getStarted", message: "Get Started" });
```

Nextra controls with hardcoded labels, such as "Copy page" and "Skip to Content",
still use the library's English text; its current public props do not expose those
labels for translation.

Then extract, translate `src/locales/ko/messages.po`, and check:

```sh
yarn workspace mincho-docs i18n:extract
yarn workspace mincho-docs i18n:check
yarn workspace mincho-docs i18n:compile
```

Commit both `.po` catalogs. Compiled `messages.mjs` files are generated and ignored.
Development and production commands compile them automatically. `i18n:check`
refreshes the catalogs and compiles them strictly, rejecting missing translations.
Production builds run this check so newly added messages cannot bypass extraction.
English is the source locale; explicit fallback locales are omitted so missing
Korean translations fail strict compilation.
The explicit message descriptors work with the existing Rspack build without a
macro compiler plugin. Lingui 5 supports the repository's Node 20 engine range.
See [Lingui message extraction](https://lingui.dev/guides/message-extraction) and
[React server rendering](https://lingui.dev/tutorials/react-rsc).

## Documentation translations

English MDX lives in `src/content/*.mdx`, and Korean MDX in
`src/content/ko/*.mdx`. Keep matching filenames, code examples, and document
coverage. Translate headings, prose, and `_meta.ts` navigation labels. Korean
internal links use `/ko/docs/...`; do not put the deployment prefix `/mincho` into
MDX links because Next.js adds it.

Keep English heading anchors in Korean with Nextra's explicit ID syntax, for
example `## 설치 [#installation]`. This preserves deep links when switching
languages. The export tests compare every document's anchors and code blocks.
Nextra reads the Korean content under `/docs/ko`; the shared layout maps those
internal page-map entries to the public `/ko/docs` routes.
