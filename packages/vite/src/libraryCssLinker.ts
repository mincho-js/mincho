import { posix } from "node:path";
import MagicString from "magic-string";
import { findChunkDirectivePrologueEnd } from "./chunkPrologue.js";

/** Structural projection shared by Rollup's render metadata and test fixtures. */
export interface LibraryCssChunk {
  fileName: string;
  imports: string[];
  isEntry: boolean;
  isDynamicEntry: boolean;
  viteMetadata?: { importedCss?: Set<string> };
}

export interface LibraryCssLinkerOptions {
  cssCodeSplit: boolean;

  /** Exact output-relative native CSS asset name, required for unsplit CSS. */
  fileName?: string;
}

export interface LibraryCssRenderInput {
  code: string;
  chunk: LibraryCssChunk;
  chunks: Record<string, LibraryCssChunk>;
  format: string;
  ancestorStyleSpecifiers: readonly string[];
  hasOwnCss: boolean;
}

export function createLibraryCssLinker(options: LibraryCssLinkerOptions) {
  if (options.fileName !== undefined) validateFileName(options.fileName);

  const expectedCss = new Set<string>();
  let aborted: Error | undefined;
  const pendingBarriers = new Set<{ reject: (error: Error) => void }>();
  const barriers = new WeakMap<
    object,
    {
      arrived: Set<string>;
      count: number;
      promise: Promise<void>;
      resolve: () => void;
      reject: (error: Error) => void;
    }
  >();

  return {
    /** Call for every chunk from a post-order renderChunk hook, once per output. */
    async renderChunk(input: LibraryCssRenderInput) {
      if (aborted) throw aborted;

      const {
        code,
        chunk,
        chunks,
        format,
        ancestorStyleSpecifiers,
        hasOwnCss
      } = input;

      if (options.cssCodeSplit) {
        let barrier = barriers.get(chunks);

        if (!barrier) {
          let resolve!: () => void;
          let reject!: (error: Error) => void;
          const promise = new Promise<void>((done, fail) => {
            resolve = done;
            reject = fail;
          });

          barrier = {
            arrived: new Set(),
            count: Object.keys(chunks).length,
            promise,
            resolve,
            reject
          };
          barriers.set(chunks, barrier);
          pendingBarriers.add(barrier);
        }

        barrier.arrived.add(chunk.fileName);

        if (barrier.arrived.size === barrier.count) {
          pendingBarriers.delete(barrier);
          barrier.resolve();
        }

        // Vite renders different chunks concurrently. Shared chunk CSS metadata
        // is only ready after its own CSS render hook has completed.
        await barrier.promise;
      }

      if (!chunk.isEntry && !chunk.isDynamicEntry) return null;
      if (format !== "es" && format !== "cjs") return null;

      const ownCss = options.cssCodeSplit
        ? collectStaticCss(chunk, chunks)
        : hasOwnCss
          ? [requireUnsplitFileName(options.fileName)]
          : [];
      if (options.cssCodeSplit && hasOwnCss && ownCss.length === 0) {
        throw new Error(
          `Mincho library CSS sidecar for entry chunk ${chunk.fileName} expected one emitted CSS asset for unsplit output or at least one for split output, found 0 after all CSS render hooks completed.`
        );
      }

      const specifiers = new Set(
        ancestorStyleSpecifiers.filter(
          (specifier) => !chunk.imports.includes(specifier)
        )
      );

      for (const fileName of ownCss) {
        expectedCss.add(fileName);

        const relative = posix.relative(
          posix.dirname(chunk.fileName),
          fileName
        );

        const specifier =
          relative.startsWith("./") || relative.startsWith("../")
            ? relative
            : `./${relative}`;

        if (!chunk.imports.includes(specifier)) specifiers.add(specifier);
      }

      if (!specifiers.size) return null;

      const statements = [...specifiers].map((specifier) =>
        format === "es"
          ? `import ${JSON.stringify(specifier)};`
          : `require(${JSON.stringify(specifier)});`
      );

      const edit = new MagicString(code);
      const insertion = findChunkDirectivePrologueEnd(code);
      const prefix = code.slice(0, insertion);
      const separator =
        insertion === 0 ||
        /[\r\n\u2028\u2029]$/.test(prefix) ||
        prefix.trimEnd().endsWith(";") ||
        prefix === "\ufeff"
          ? ""
          : "\n";

      edit.appendLeft(insertion, `${separator}${statements.join("\n")}\n`);

      for (const specifier of specifiers) {
        if (!chunk.imports.includes(specifier)) chunk.imports.push(specifier);
      }

      return { code: edit.toString(), map: edit.generateMap({ hires: true }) };
    },

    abort(error: Error) {
      aborted = error;

      for (const barrier of pendingBarriers) barrier.reject(error);

      pendingBarriers.clear();
    },

    /** Validation only: native output bytes, maps and hashes remain untouched. */
    validateBundle(
      bundle: Record<
        string,
        {
          type: string;
          fileName: string;
          originalFileNames?: readonly string[];
        }
      >,
      context: { validatedUnsplitCss?: Set<string> } = {}
    ) {
      const nativeUnsplitCss = options.cssCodeSplit
        ? []
        : Object.values(bundle).filter(
            (asset) =>
              asset.type === "asset" &&
              asset.fileName.endsWith(".css") &&
              asset.originalFileNames?.includes("style.css")
          );

      for (const fileName of expectedCss) {
        const asset = bundle[fileName];

        // Vite can emit unsplit CSS only in the first format. The caller must
        // scope this set to one build generation and one output directory.
        if (
          !asset &&
          !options.cssCodeSplit &&
          nativeUnsplitCss.length === 0 &&
          context.validatedUnsplitCss?.has(fileName)
        )
          continue;
        if (!asset || asset.type !== "asset" || asset.fileName !== fileName) {
          throw new Error(
            `Mincho library CSS asset ${JSON.stringify(fileName)} was linked before hashing but was not emitted. ` +
              "For unsplit CSS, libraryCss.fileName must exactly match Vite's emitted output-relative CSS filename."
          );
        }
        if (
          !options.cssCodeSplit &&
          (nativeUnsplitCss.length !== 1 || nativeUnsplitCss[0] !== asset)
        ) {
          throw new Error(
            `Mincho libraryCss.fileName ${JSON.stringify(fileName)} does not identify Vite's native unsplit CSS asset (originalFileNames must include "style.css"). Native CSS assets: ${nativeUnsplitCss.map((candidate) => candidate.fileName).join(", ") || "none"}.`
          );
        }

        if (!options.cssCodeSplit) context.validatedUnsplitCss?.add(fileName);
      }
    }
  };
}

function requireUnsplitFileName(fileName: string | undefined): string {
  if (fileName !== undefined) return fileName;

  throw new Error(
    "Mincho library CSS with cssCodeSplit: false requires an explicit libraryCss.fileName matching the fixed output-relative CSS filename. " +
      "Vite finalizes unsplit CSS after JavaScript hashes; provide a fixed filename or enable cssCodeSplit."
  );
}

function validateFileName(fileName: string): void {
  if (
    !fileName.endsWith(".css") ||
    fileName.startsWith("/") ||
    ["\\", "\0", "?", "#", "[", "]", ":"].some((character) =>
      fileName.includes(character)
    ) ||
    fileName.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "Mincho libraryCss.fileName must be a fixed output-relative .css filename without placeholders, queries, or parent traversal."
    );
  }
}

function collectStaticCss(
  root: LibraryCssChunk,
  chunks: Record<string, LibraryCssChunk>
): string[] {
  const css = new Set<string>();
  const visited = new Set<string>();
  const pending: { chunk: LibraryCssChunk; exit: boolean }[] = [
    { chunk: root, exit: false }
  ];

  while (pending.length) {
    const frame = pending.pop()!;

    if (frame.exit) {
      for (const fileName of frame.chunk.viteMetadata?.importedCss ?? [])
        css.add(fileName);

      continue;
    }

    if (visited.has(frame.chunk.fileName)) continue;

    visited.add(frame.chunk.fileName);
    pending.push({ chunk: frame.chunk, exit: true });

    for (const imported of [...frame.chunk.imports].reverse()) {
      const child = chunks[imported];

      if (child) pending.push({ chunk: child, exit: false });
    }
  }

  return [...css];
}
