import { describe, expect, it } from "vitest";
import { createRef, forwardRef } from "react";
import type { ComponentPropsWithoutRef } from "react";
import { renderToString } from "react-dom/server";
import { Box, HStack, Item, VStack } from "./index.js";

describe("React DOM server contract", () => {
  it("renders semantic HTML and strips layout props", () => {
    const html = renderToString(
      <VStack as="ul" width={300} gap={8}>
        <Item as="li" height={20} shrink={false}>
          Entry
        </Item>
      </VStack>
    );
    expect(html).toMatch(/^<ul /);
    expect(html).toContain("<li ");
    expect(html).toContain("row-gap:8px");
    expect(html).not.toContain('gap="');
    expect(html).not.toContain('shrink="');
    expect(html).toContain('data-mincho-layout-state="pending"');
  });

  it("renders parent-independent declarations as CSS variables", () => {
    const html = renderToString(
      <HStack width={400} gap={12}>
        <Item width={100} />
        <VStack width="stretch">
          <Item width={100} gapBefore={20} gapAfter="stretch" />
        </VStack>
      </HStack>
    );
    expect(html).not.toContain("<style");
    expect(html).toContain('data-mincho-layout-axis="horizontal"');
    expect(html).toContain("--mincho-layout-gap:12px");
    expect(html).toContain("--mincho-layout-w:100px");
    // A stretch width is the main size under HStack and cross size under VStack.
    expect(html).toContain("--mincho-layout-w-main:0px");
    expect(html).toContain("--mincho-layout-w-cross:auto");
    expect(html).toContain("--mincho-layout-grow-w:10000");
    expect(html).toContain("--mincho-layout-before:20px");
    expect(html).toContain("--mincho-layout-after-auto:auto");
    expect(html).not.toMatch(/(?:^|;)(?:width|margin-inline-start):/);
  });

  it("rejects position-dependent stretch space bounds during render", () => {
    expect(() =>
      renderToString(
        <HStack width={400} gap={12}>
          <Item width={100} />
          <Item
            width={100}
            gapBefore={{ size: "stretch", minSize: 12 } as never}
          />
        </HStack>
      )
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it("uses the selected native as target without a wrapper", () => {
    const html = renderToString(
      <HStack width={400}>
        <Item
          as="a"
          href="/save"
          width={100}
          className="link"
          style={{ color: "red" }}
        >
          Save
        </Item>
      </HStack>
    );
    expect(html).toContain('href="/save"');
    expect(html).toContain('class="link"');
    expect(html).toContain("color:red");
    expect(html.match(/<div /g)).toHaveLength(1);
  });

  it("renders custom as targets through React and forwards their props", () => {
    let renders = 0;
    const Link = forwardRef<
      HTMLAnchorElement,
      Omit<ComponentPropsWithoutRef<"a">, "href"> & { to: string }
    >(({ to, ...props }, ref) => {
      renders++;
      return <a {...props} href={to} ref={ref} />;
    });
    const anchor = createRef<HTMLAnchorElement>();
    const html = renderToString(
      <HStack width={400}>
        <Item
          as={Link}
          to="/save"
          ref={anchor}
          width={100}
          className="link"
          style={{ color: "red" }}
        >
          Save
        </Item>
      </HStack>
    );
    expect(renders).toBe(1);
    expect(html).toContain('href="/save"');
    expect(html).toContain('class="link"');
    expect(html).toContain("--mincho-layout-w:100px");
    expect(html).not.toContain('to="');
    expect(html.match(/<div /g)).toHaveLength(1);
    // @ts-expect-error the custom as target requires its own props
    const missing = <Item as={Link} />;
    const buttonRef = createRef<HTMLButtonElement>();
    // @ts-expect-error ref follows the selected target
    const wrongRef = <Item as={Link} to="/save" ref={buttonRef} />;
    // @ts-expect-error asChild was removed in favor of as
    const removed = <Item asChild />;
    expect([missing, wrongRef, removed]).toHaveLength(3);
  });

  it("allows typography overflow decoration", () => {
    const html = renderToString(
      <Box
        style={{
          overflowWrap: "anywhere",
          overflowAnchor: "none",
          overflowClipMargin: "4px",
          WebkitTextFillColor: "red"
        }}
      >
        Text
      </Box>
    );
    expect(html).toContain("overflow-wrap:anywhere");
    expect(html).toContain("overflow-anchor:none");
    expect(html).toContain("overflow-clip-margin:4px");
  });

  it.each([
    "overflow",
    "overflowX",
    "overflowY",
    "overflowInline",
    "overflowBlock"
  ])("still rejects layout-owned style.%s overrides", (property) => {
    expect(() =>
      renderToString(<Box style={{ [property]: "hidden" }} />)
    ).toThrow("E_LAYOUT_CAPABILITY");
  });

  it("allows stretch items to explicitly disable shrink", () => {
    expect(() =>
      renderToString(
        <HStack width={400}>
          <Item width="stretch" shrink={false} />
        </HStack>
      )
    ).not.toThrow();
  });

  it.each([
    { placeSelf: "end" },
    { placeItems: "end" },
    { placeContent: "end" },
    { all: "unset" },
    { WebkitAlignItems: "flex-end" },
    { WebkitFlexGrow: 1 },
    { WebkitBoxSizing: "content-box" },
    { WebkitLogicalWidth: "40px" }
  ] as const)(
    "rejects shorthands and aliases that reset layout styles: %j",
    (style) => {
      expect(() => renderToString(<HStack style={style} />)).toThrow(
        "E_LAYOUT_CAPABILITY"
      );
    }
  );

  it.each([
    { padding: 0 },
    { position: "static" as const },
    { overflow: "visible" as const },
    { boxSizing: "border-box" as const }
  ])("rejects owned styles even when they match defaults: %j", (style) => {
    expect(() => renderToString(<Box style={style} />)).toThrow(
      "E_LAYOUT_CAPABILITY"
    );
  });

  it("ignores undefined layout-owned style values", () => {
    expect(() =>
      renderToString(<Box style={{ padding: undefined }} />)
    ).not.toThrow();
  });

  it("does not call arbitrary user components to infer their roots", () => {
    let calls = 0;
    const Empty = () => {
      calls++;
      return null;
    };
    renderToString(
      <HStack>
        <Empty />
        <button>Save</button>
      </HStack>
    );
    expect(calls).toBe(1);
  });

  it("rejects invalid and unsupported combinations on the server", () => {
    expect(() => renderToString(<Item />)).toThrow("E_INVALID_ITEM_PARENT");
    expect(() =>
      renderToString(
        <HStack wrap>
          <Item gapBefore={20} />
        </HStack>
      )
    ).toThrow("E_LAYOUT_CAPABILITY");
    expect(() =>
      renderToString(
        <HStack justify="between">
          <Item gapBefore={20} />
        </HStack>
      )
    ).toThrow("E_MIXED_SPACE_DISTRIBUTION");
    expect(() => renderToString(<Box style={{ display: "flex" }} />)).toThrow(
      "E_LAYOUT_CAPABILITY"
    );
  });

  it("types intrinsic props and refs for as", () => {
    const anchor = createRef<HTMLAnchorElement>();
    const element = (
      <Box
        as="a"
        href="/"
        ref={anchor}
        onClick={(event) => event.currentTarget.href}
      />
    );
    expect(element.props.as).toBe("a");
    // @ts-expect-error div has no href
    const invalidHost = <Box href="/" />;
    // @ts-expect-error VStack cannot align to baseline
    const invalidAlign = <VStack align="baseline" />;
    // @ts-expect-error padding systems cannot be mixed
    const invalidPadding = <Box padding={{ top: 1, inline: 2 }} />;
    // @ts-expect-error absolute items cannot have relations
    const invalidAbsolute = <Item position="absolute" gapBefore={1} />;
    // @ts-expect-error the native renderer has no strong-break implementation
    const invalidBreak = <Item breakBefore="never" />;
    // @ts-expect-error bounded spaces require a precision renderer
    const invalidSpace = <Item gapBefore={{ size: "stretch", minSize: 12 }} />;
    expect([
      invalidHost,
      invalidAlign,
      invalidPadding,
      invalidAbsolute,
      invalidBreak,
      invalidSpace
    ]).toHaveLength(6);
  });
});
