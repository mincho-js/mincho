import { describe, expect, it } from "vitest";
import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SquircleMask } from "./index.js";
import type { SquircleMaskProps } from "./index.js";

describe("SquircleMask server rendering", () => {
  it("renders an immediately usable fixed mask and forwards host props", () => {
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
    expect(html).toContain("mask-image:var(--mincho-squircle-image, url(");
    expect(html).toContain("data:image/svg+xml,");
    expect(html).toContain("width:200px");
    expect(html).not.toMatch(/(?:radius|smoothing|cacheMask|as)="/);
  });

  it("renders a deterministic rounded fallback for content sizing", () => {
    const html = renderToStaticMarkup(
      <SquircleMask radius={20}>Content</SquircleMask>
    );
    expect(html).toContain("mask-image:var(--mincho-squircle-image, none)");
    expect(html).toContain("border-radius:var(--mincho-squircle-radius, 20px)");
    expect(html).toContain("--mincho-squircle-image:initial");
    expect(html).not.toContain("data:image");
  });

  it("uses native CSS for zero smoothing and validates non-finite inputs", () => {
    const html = renderToStaticMarkup(
      <SquircleMask smoothing={0} radius={12} />
    );
    expect(html).toContain("mask-image:var(--mincho-squircle-image, none)");
    expect(html).toContain("border-radius:var(--mincho-squircle-radius, 12px)");
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
