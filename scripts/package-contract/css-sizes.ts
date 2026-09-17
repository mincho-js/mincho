import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { PackageContractError } from "./types.js";
import { assertDiamondSelectorsOnce } from "./diamond-artifacts.js";

/** Count transfer bytes per file; combining files changes compression results. */
export async function reportCssSizes(consumerRoot: string): Promise<void> {
  const reports = [];

  for (const bundler of ["vite", "esbuild"]) {
    for (const mode of ["dist", "dist-minified"]) {
      const root = join(consumerRoot, "fixture", bundler, mode);
      const files = (
        await readdir(root, { recursive: true, withFileTypes: true })
      )
        .filter((file) => file.isFile() && /\.(css|[cm]?js)$/.test(file.name))
        .map((file) => join(file.parentPath, file.name))
        .sort();
      if (files.length === 0)
        throw new PackageContractError(`No CSS artifacts in ${root}`);

      const sources = [];

      for (const file of files) {
        const bytes = await readFile(file);

        if (file.endsWith(".css")) sources.push(bytes.toString("utf8"));

        reports.push({
          kind: file.endsWith(".css") ? "css" : "javascript",
          bundler,
          minified: mode === "dist-minified",
          file: relative(root, file),
          raw: bytes.length,
          gzip: gzipSync(bytes, { level: 9 }).length,
          brotli: brotliCompressSync(bytes, {
            params: { [constants.BROTLI_PARAM_QUALITY]: 11 }
          }).length
        });
      }

      // This fixture's eager diamond has one CSS ownership path per producer.
      assertDiamondSelectorsOnce(sources.join("\n"), `${bundler}/${mode}`);
    }
  }

  await writeFile(
    join(consumerRoot, "css-sizes.json"),
    `${JSON.stringify(
      reports.filter((report) => report.kind === "css"),
      null,
      2
    )}\n`
  );
  await writeFile(
    join(consumerRoot, "artifact-sizes.json"),
    `${JSON.stringify(reports, null, 2)}\n`
  );
  console.log(
    `[package-contract] JS/CSS transfer sizes: ${JSON.stringify(reports)}`
  );
}
