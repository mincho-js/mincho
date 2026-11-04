import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { selectors } from "./index.js";

describe.skipIf(process.env.MINCHO_SELECTORS_BROWSER !== "1")(
  "selectors in a real DOM",
  () => {
    let browser: Browser;
    let page: Page;
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
      });
      page = await browser.newPage();
    });
    afterAll(async () => {
      await browser?.close();
    });

    const matches = (selector: string) =>
      page.evaluate(
        (value) =>
          Array.from(document.querySelectorAll(value), (element) => element.id),
        selector
      );

    it("counts only matching direct children, including overlapping selector lists", async () => {
      for (let count = 0; count <= 9; count++) {
        await page.setContent(
          `<div class="list">noise<i></i>${Array.from(
            { length: count },
            (_, i) => `<span id="i${i + 1}" class="item also"></span><em></em>`
          ).join("")}<aside><b class="item" id="nested"></b></aside></div>`
        );
        const cases: [selectors.Condition, (index: number) => boolean][] = [
          [selectors.first(), (i) => i === 1],
          [selectors.first(2), (i) => i <= 2],
          [selectors.last(), (i) => i === count],
          [selectors.last(2), (i) => i > count - 2],
          [selectors.nth(3), (i) => i === 3],
          [selectors.nthLast(2), (i) => i === count - 1],
          [selectors.from(3), (i) => i >= 3],
          [selectors.before(3), (i) => i < 3],
          [selectors.before(1), () => false],
          [selectors.after(3), (i) => i > 3],
          [selectors.between(2, 4), (i) => i >= 2 && i <= 4],
          [
            selectors.between(2, 4, { from: "end" }),
            (i) => count - i + 1 >= 2 && count - i + 1 <= 4
          ],
          [selectors.every(3), (i) => i % 3 === 0],
          [selectors.every(3, { startAt: 1 }), (i) => i % 3 === 1],
          [selectors.every(3, { startAt: 4 }), (i) => i >= 4 && i % 3 === 1],
          [
            selectors.every(3, { from: "end" }),
            (i) => (count - i + 1) % 3 === 0
          ],
          [
            selectors.every(3, { from: "end", startAt: 1 }),
            (i) => (count - i) % 3 === 0
          ],
          [selectors.odd(), (i) => i % 2 === 1],
          [selectors.even(), (i) => i % 2 === 0],
          [selectors.count(0), () => count === 0],
          [selectors.count(5), () => count === 5],
          [selectors.countAtLeast(0), () => true],
          [selectors.countAtLeast(5), () => count >= 5],
          [selectors.countAtMost(5), () => count <= 5],
          [selectors.countOver(5), () => count > 5],
          [selectors.countUnder(5), () => count < 5],
          [selectors.countBetween(2, 4), () => count >= 2 && count <= 4],
          [selectors.countMultipleOf(3), () => count % 3 === 0],
          [selectors.countOdd(), () => count % 2 === 1],
          [selectors.countEven(), () => count % 2 === 0],
          [
            selectors.all(selectors.countAtLeast(5), selectors.between(2, 4)),
            (i) => count >= 5 && i >= 2 && i <= 4
          ],
          [
            selectors.any(selectors.first(), selectors.last()),
            (i) => i === 1 || i === count
          ],
          [
            selectors.none(selectors.nth(3), selectors.last()),
            (i) => i !== 3 && i !== count
          ],
          [
            selectors.any(
              selectors.count(3),
              selectors.none(selectors.first())
            ),
            (i) => count === 3 || i !== 1
          ],
          [selectors.all(), () => true],
          [selectors.any(), () => false],
          [selectors.none(), () => true]
        ];
        const inputs = cases.map(([condition]) =>
          selectors.children(".list", ".item, .also", condition)
        );
        const results = await page.evaluate(
          (values) =>
            values.map((value) =>
              Array.from(
                document.querySelectorAll(value),
                (element) => element.id
              )
            ),
          inputs
        );
        cases.forEach(([, expected], index) => {
          const ids = Array.from({ length: count }, (_, i) => i + 1)
            .filter(expected)
            .map((i) => `i${i}`);
          expect(results[index], `count=${count}: ${inputs[index]}`).toEqual(
            ids
          );
        });
      }
    });

    it("preserves selector composition semantics in the browser", async () => {
      await page.setContent(
        '<div class="a"><div class="b"><button class="x y primary" id="target"></button><a class="x" id="link"></a></div></div><div class="a" id="one"></div><div class="b" id="two"></div>'
      );
      expect(await matches(selectors.unify(".a .x", ".b .y"))).toEqual([
        "target"
      ]);
      expect(await matches(selectors.unify("button", ".primary"))).toEqual([
        "target"
      ]);
      expect(await matches(selectors.unify("button", "a"))).toEqual([]);
      expect(await matches(selectors.nest(".a, .b", "& + &"))).toEqual([
        "one",
        "two"
      ]);
      expect(
        await matches(selectors.replace(".b > .x", ".x", ".primary"))
      ).toEqual(["target"]);
      expect(await matches(selectors.where("button, a", ".primary"))).toEqual([
        "target"
      ]);
      expect(await matches(selectors.is("button, a", ".primary"))).toEqual([
        "target"
      ]);
      expect(await matches(selectors.exclude("button, a", ".primary"))).toEqual(
        ["link"]
      );
      expect(
        await matches(selectors.children(".a, .b", ".x", selectors.count(2)))
      ).toEqual(["target", "link"]);
    });

    it("preserves escaped trailing whitespace in identifiers", async () => {
      await page.setContent('<section id="card "><b id="item "></b></section>');
      expect(await matches(selectors.nest("#card\\ ", "#item\\ "))).toEqual([
        "item "
      ]);
      expect(await matches(selectors.is("#item\\ ", "b"))).toEqual(["item "]);
      expect(
        await matches(
          selectors.children("#card\\ ", "#item\\ ", selectors.first())
        )
      ).toEqual(["item "]);
    });

    it("keeps commented relative selectors valid", async () => {
      await page.setContent(
        '<div class="list" id="list"><b class="item" id="direct"></b><aside><b class="item" id="nested"></b></aside></div>'
      );
      expect(
        await matches(selectors.nest(".list", "/*keep*/ > .item"))
      ).toEqual(["direct"]);
      expect(await matches(selectors.has(".list", "/*keep*/ > .item"))).toEqual(
        ["list"]
      );
    });

    it("negates the whole parent list, including through nested pseudos", async () => {
      await page.setContent(
        '<div class="item a" id="a"></div><div class="item b" id="b"></div><div class="item a b" id="both"></div><div class="item" id="neither"></div>'
      );
      for (const child of [".item:not(&)", ".item:not(:is(&))"])
        expect(await matches(selectors.nest(".a, .b", child))).toEqual([
          "neither"
        ]);
      expect(
        await matches(selectors.nest(".a, .b", ".item:not(:not(&))"))
      ).toEqual(["a", "b", "both"]);
    });

    it("distinguishes type names containing Unicode whitespace", async () => {
      await page.setContent(
        '<a id="plain"></a><a\u00a0 id="spaced"></a\u00a0>'
      );
      expect(await matches(selectors.nest("a\u00a0"))).toEqual(["spaced"]);
      expect(await matches(selectors.unify("a", "a\u00a0"))).toEqual([]);
      expect(await matches(selectors.replace("a\u00a0", "a", "b"))).toEqual([
        "spaced"
      ]);
    });

    it("counts a combined parent list within positional nesting predicates", async () => {
      await page.setContent(
        '<div class="a" id="a"></div><div class="b" id="b"></div><div class="a b" id="both"></div><div id="neither"></div>'
      );
      for (const name of ["nth-child", "nth-last-child"])
        expect(
          await matches(selectors.nest(".a, .b", `:${name}(2 of &)`))
        ).toEqual(["b"]);
    });

    it("preserves generated content on shadow parts after replacement and nesting", async () => {
      await page.setContent('<x-foo class="active"></x-foo>');
      await page.evaluate(() => {
        const host = document.querySelector("x-foo")!;
        const label = document.createElement("span");
        label.setAttribute("part", "label");
        host.attachShadow({ mode: "open" }).append(label);
      });
      const unchanged = selectors.replace(
        "x-foo::part(label)/*keep*/::before",
        ".missing",
        ".other"
      );
      const changed = selectors.replace(
        "x-foo.old::part(label)::before",
        ".old",
        ".active"
      );
      const nested = selectors.nest("x-foo::part(label)", "&/*keep*/::before");
      await page.addStyleTag({
        content: `${unchanged} { content: "marker" } ${changed} { color: rgb(12, 34, 56) } ${nested} { background-color: rgb(65, 43, 21) }`
      });
      expect(
        await page.evaluate(() => {
          const label =
            document.querySelector("x-foo")!.shadowRoot!.firstElementChild!;
          const style = getComputedStyle(label, "::before");
          return {
            content: style.content,
            color: style.color,
            backgroundColor: style.backgroundColor
          };
        })
      ).toEqual({
        content: '"marker"',
        color: "rgb(12, 34, 56)",
        backgroundColor: "rgb(65, 43, 21)"
      });
    });
  }
);
