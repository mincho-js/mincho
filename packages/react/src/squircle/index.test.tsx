import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquircleMask } from "./index.js";
import type { SquircleMaskProps } from "./index.js";

describe("SquircleMask server rendering", () => {
  it("renders an immediately usable fixed clip and forwards host props", () => {
    const html = renderToStaticMarkup(
      <SquircleMask
        as="button"
        width={200}
        height={100}
        radius={20}
        type="button"
        aria-label="Save"
        className="surface"
      >
        Save
      </SquircleMask>
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Save"');
    expect(html).toContain("clip-path:path(&quot;M");
    expect(html).toContain("border-radius:0");
    expect(html).not.toContain("data:image");
    expect(html).not.toContain("mask-image");
    expect(html).toContain("width:200px");
    expect(html).not.toMatch(/(?:radius|smoothing|cacheMask|as)="/);
  });

  it("renders shared classes with stable sizing and rounded SSR clipping", () => {
    const html = renderToStaticMarkup(
      <SquircleMask radius={20.5} smoothing={0.8} className="card">
        Content
      </SquircleMask>
    );
    expect(html).toContain(
      'class="mincho-squircle mincho-squircle-r20_5-s0_8 card"'
    );
    expect(html).toContain("box-sizing:border-box");
    expect(html).toContain("overflow:hidden");
    expect(html).toContain("border-radius:20.5px");
    const sized = renderToStaticMarkup(
      <SquircleMask
        width={240}
        radius={20}
        style={{ height: 140, padding: 20, border: "10px solid black" }}
      />
    );
    expect(sized).toContain("width:240px");
    expect(sized).toContain("height:140px");
    expect(sized).toContain("box-sizing:border-box");
    expect(sized).toContain("overflow:hidden");
  });

  it("uses native CSS for zero smoothing and validates non-finite inputs", () => {
    const html = renderToStaticMarkup(
      <SquircleMask smoothing={0} radius={12} />
    );
    expect(html).toContain("clip-path:none");
    expect(html).toContain("border-radius:12px");
    expect(html).not.toContain("mincho-squircle");
    const fixed = renderToStaticMarkup(
      <SquircleMask width={100} height={60} smoothing={0} radius={12} />
    );
    expect(fixed).toContain("clip-path:none");
    expect(fixed).toContain("border-radius:12px");
    expect(() => renderToStaticMarkup(<SquircleMask radius={NaN} />)).toThrow(
      RangeError
    );
  });

  it("types the selected host's attributes and ref", () => {
    const anchor: SquircleMaskProps<"a"> = {
      as: "a",
      href: "/",
      ref: createRef<HTMLAnchorElement>()
    };
    // @ts-expect-error href is not a button attribute
    const invalid: SquircleMaskProps<"button"> = { as: "button", href: "/" };
    void invalid;
    expect(renderToStaticMarkup(<SquircleMask {...anchor} />)).toContain(
      'href="/"'
    );
  });
});
