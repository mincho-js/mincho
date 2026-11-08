import assert from "node:assert/strict";
import { readFile, readdir, access } from "node:fs/promises";
import { sep } from "node:path";
import { test } from "node:test";

const site = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, site), "utf8");
const documentNames = async (directory) =>
  (await readdir(new URL(directory, site), { recursive: true }))
    .filter((name) => name.endsWith(".mdx"))
    .map((name) => name.slice(0, -4).split(sep).join("/"))
    .sort();
const documents = (await documentNames("src/content/")).filter(
  (name) => !name.startsWith("ko/")
);
const headings = (html) =>
  [...html.matchAll(/<h[2-6]\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1]);

function assertLanguageAlternates(html, englishPath, koreanPath) {
  const links = Object.fromEntries(
    [
      ...html.matchAll(/<link\b[^>]*hrefLang="([^"]+)"[^>]*href="([^"]+)"/gi)
    ].map((match) => [match[1], match[2]])
  );
  for (const [locale, pathname] of Object.entries({
    en: englishPath,
    ko: koreanPath,
    "x-default": englishPath
  })) {
    const url = new URL(links[locale]);
    assert.equal(url.origin, "https://mincho-js.github.io");
    assert.equal(url.pathname, pathname);
  }
}

test("both languages contain the same documentation pages", async () => {
  assert.deepEqual(await documentNames("src/content/ko/"), documents);
});

test("both languages export localized home pages with the right document links", async () => {
  const english = await read("out/index.html");
  const korean = await read("out/ko/index.html");
  assert.match(english, /<html[^>]*lang="en"/);
  assert.match(korean, /<html[^>]*lang="ko"/);
  assert.match(english, /Natural CSS in TypeScript/);
  assert.match(korean, /TypeScript에서 자연스럽게 작성하는 CSS/);
  assert.match(english, /href="\/mincho\/docs\/?"/);
  assert.match(korean, /href="\/mincho\/ko\/docs\/?"/);
  assert.match(english, /aria-label="Select language"/);
  assert.match(korean, /aria-label="언어 선택"/);
  for (const html of [english, korean]) {
    assertLanguageAlternates(html, "/mincho/", "/mincho/ko/");
  }
});

for (const document of documents) {
  test(`${document}: translated export keeps examples, anchors and links valid`, async () => {
    const route =
      document === "index" ? "" : `${document.replace(/\/index$/, "")}/`;
    const [english, korean, source, translation] = await Promise.all([
      read(`out/docs/${route}index.html`),
      read(`out/ko/docs/${route}index.html`),
      read(`src/content/${document}.mdx`),
      read(`src/content/ko/${document}.mdx`)
    ]);
    assert.match(english, /<html[^>]*lang="en"/);
    assert.match(korean, /<html[^>]*lang="ko"/);
    assert.match(korean, /이 페이지의 내용/);
    assert.match(korean, /문서 검색/);
    assert.match(korean, /이 페이지 편집/);
    for (const html of [english, korean]) {
      assert.equal(
        (html.match(/<main\b/g) || []).length,
        1,
        "render the docs shell only once"
      );
    }
    const englishTitle = english.match(/<h1\b[^>]*>(.*?)<\/h1>/s)?.[1];
    const koreanTitle = korean.match(/<h1\b[^>]*>(.*?)<\/h1>/s)?.[1];
    assert.ok(englishTitle);
    assert.match(koreanTitle, /[가-힣]/);
    assert.notEqual(koreanTitle, englishTitle);
    assert.deepEqual(
      headings(korean),
      headings(english),
      "language switching must preserve heading anchors"
    );

    const codeBlocks = (mdx) => mdx.match(/^```[^\n]*\n[\s\S]*?^```/gm);
    assert.deepEqual(
      codeBlocks(translation),
      codeBlocks(source),
      "translation must preserve code examples"
    );
    for (const match of korean.matchAll(/<a\b[^>]*\bhref="([^"#]+)"/g)) {
      const href = match[1];
      if (!href.startsWith("/mincho/")) continue;
      const { pathname } = new URL(href, "https://example.test");
      assert.ok(
        pathname.startsWith("/mincho/ko"),
        `Korean navigation leaves its locale: ${href}`
      );
      const outputPath = pathname.replace(/^\/mincho\//, "").replace(/\/$/, "");
      await access(new URL(`out/${outputPath}/index.html`, site));
    }
    for (const html of [english, korean]) {
      const path = route ? `/${route.slice(0, -1)}` : "";
      assertLanguageAlternates(
        html,
        `/mincho/docs${path}/`,
        `/mincho/ko/docs${path}/`
      );
    }
  });
}

test("search ships indexes for English and Korean", async () => {
  const { languages } = JSON.parse(
    await read("out/_pagefind/pagefind-entry.json")
  );
  assert.ok(languages.en);
  assert.ok(languages.ko);
  assert.equal(languages.en.page_count, documents.length);
  assert.equal(languages.ko.page_count, documents.length);
});
