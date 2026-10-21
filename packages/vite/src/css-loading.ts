import type { MinchoSsrStylesheet } from "./ssr.js";

type Load = { url: string; promise: Promise<void>; failed: boolean };

const loads = new WeakMap<HTMLLinkElement, Load>();

/**
 * Optional route/SSR handoff: await external or newly created stylesheet links
 * before committing content. No CSS generation, render effects or unmount cleanup.
 * A subsequent call can retry a failed load; successful resources stay shared.
 */
export async function loadStylesheets(
  stylesheets: readonly MinchoSsrStylesheet[],
  options: {
    document?: Document;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}
): Promise<void> {
  const document = options.document ?? globalThis.document;
  if (!document?.head)
    throw new Error("loadStylesheets requires a browser document.");

  options.signal?.throwIfAborted();

  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0)
    throw new Error("timeoutMs must be a positive finite number.");

  const unique = new Map(stylesheets.map((link) => [link.href, link]));
  const sources = [...unique.values()].map((stylesheet) => ({
    stylesheet,
    url: new URL(stylesheet.href, document.baseURI).href
  }));

  const pending = sources.map(({ stylesheet, url }) => {
    let link = [
      ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')
    ].find(
      (candidate) =>
        candidate.href === url &&
        !candidate.disabled &&
        (!candidate.media || candidate.media === "all")
    );

    const previous = link ? loads.get(link) : undefined;

    if (link && previous?.url === url && previous.failed) {
      // Only a resource whose failure this helper observed is replaced.
      link.remove();
      link = undefined;
    }

    if (link && previous?.url === url) return previous.promise;

    const created = !link;
    link ??= document.createElement("link");

    const element = link;
    const load: Load = { url, promise: Promise.resolve(), failed: false };
    load.promise = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => error("Timed out loading"), timeoutMs);

      const clean = () => {
        clearTimeout(timeout);
        element.removeEventListener("load", ready);
        element.removeEventListener("error", error);
      };

      const ready = () => {
        if (element.href !== url) {
          error("Stylesheet URL changed while loading");

          return;
        }

        clean();
        resolve();
      };

      const error = (reason: Event | string = "Failed to load") => {
        clean();
        load.failed = true;
        reject(
          new Error(
            `${typeof reason === "string" ? reason : "Failed to load"} stylesheet: ${url}`
          )
        );
      };

      element.addEventListener("load", ready);
      element.addEventListener("error", error);

      if (created) {
        element.rel = "stylesheet";
        element.crossOrigin = stylesheet.crossOrigin;
        element.href = stylesheet.href;
        document.head.appendChild(element);
      } else if (element.getAttribute("href") !== stylesheet.href) {
        // Match Vite's href-attribute lookup as well as browser URL identity.
        element.setAttribute("href", stylesheet.href);
      }

      if (element.sheet) {
        // Chromium can retain an empty CSSStyleSheet after an HTTP error.
        // Presence alone is not proof that an unobserved load succeeded.
        let hasRules = false;

        try {
          hasRules = element.sheet.cssRules.length > 0;
        } catch {
          /* Cross-origin CSSOM may be opaque. */
        }

        const timings = document.defaultView?.performance.getEntriesByName(
          url,
          "resource"
        );

        const status = (
          timings?.at(-1) as PerformanceResourceTiming | undefined
        )?.responseStatus;

        if (hasRules || (status !== undefined && status >= 200 && status < 400))
          ready();
        else if (status !== undefined && status >= 400) error();
        // Otherwise wait for load/error or the bounded timeout.
      }
    });
    loads.set(element, load);

    return load.promise;
  });

  const ready = Promise.all(pending).then(() => {});
  const signal = options.signal;
  if (!signal) return ready;

  // Aborting one caller must not remove resources another root still needs.
  await new Promise<void>((resolve, reject) => {
    const abort = () => reject(signal.reason);

    signal.addEventListener("abort", abort, { once: true });
    ready
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));

    if (signal.aborted) abort();
  });
}
