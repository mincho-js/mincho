import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Stylesheets } from "./stylesheets.js";

describe("React stylesheet resource adapter", () => {
  it("deduplicates across component instances without consuming request state", () => {
    const links = [{ href: "/shared.css" }, { href: "/route.css" }];

    const render = () =>
      renderToString(
        createElement(
          "main",
          null,
          createElement(Stylesheets, { stylesheets: links }),
          createElement(Stylesheets, { stylesheets: links })
        )
      );

    const html = render();

    expect(html.match(/href="\/shared.css"/g)).toHaveLength(1);
    expect(html.match(/href="\/route.css"/g)).toHaveLength(1);
    expect(html.indexOf("/shared.css")).toBeLessThan(
      html.indexOf("/route.css")
    );
    expect(html).toContain('data-precedence="mincho"');
    expect(render()).toEqual(html);
  });
});
