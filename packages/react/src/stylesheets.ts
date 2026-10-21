import { createElement, Fragment, version } from "react";

export interface StylesheetsProps {
  /** Ordered output from resolveSsrStylesheets; duplicate hrefs are supported. */
  stylesheets: readonly {
    href: string;
    crossOrigin?: "" | "anonymous" | "use-credentials";
  }[];

  /** React orders precedence groups by first appearance, not alphabetically. */
  precedence?: string;
}

/**
 * Optional React 19 resource adapter. React owns deduplication, hoisting and
 * stylesheet/Suspense readiness; rendering never drains request-global state.
 * onLoad/onError are deliberately not exposed: they disable resource handling.
 */
export function Stylesheets({
  stylesheets,
  precedence = "mincho"
}: StylesheetsProps) {
  if (Number.parseInt(version, 10) < 19)
    throw new Error("@mincho-js/react/stylesheets requires React 19 or newer.");

  const unique = new Map(stylesheets.map((link) => [link.href, link]));

  return createElement(
    Fragment,
    null,
    ...[...unique.values()].map((link) =>
      createElement("link", {
        key: link.href,
        rel: "stylesheet",
        href: link.href,
        crossOrigin: link.crossOrigin ?? "",
        precedence
      })
    )
  );
}
