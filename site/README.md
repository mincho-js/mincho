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

`build` compiles Lingui catalogs, exports both languages, and generates Pagefind
search indexes in `out/_pagefind`. `test` checks the exported HTML, locale-specific
links, shared anchors, unchanged code examples, and both search indexes. Run it
after `build`. To preview production, serve `out` at `/mincho/` on a static HTTP
server; Next.js `start` does not serve static exports.

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
