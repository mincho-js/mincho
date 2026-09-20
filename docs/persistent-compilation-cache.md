# Filesystem compilation cache

Mincho keeps its in-memory compilation cache enabled by default. Vite and
esbuild can opt into a filesystem cache to reuse validated Babel transforms and
compiled CSS sidecars after a process restart:

```ts
minchoVitePlugin({ cache: { type: "filesystem" } });
minchoEsbuildPlugins({ cache: { type: "filesystem" } });
```

`cache: true`, an omitted option, and `{ type: "memory" }` retain memory-only
caching. `cache: false` disables both layers. The filesystem cache also retains
the bounded memory cache described in [Memory compilation cache](./memory-compilation-cache.md).

The default directory is `<Vite cacheDir>/mincho` for Vite and
`<esbuild absWorkingDir>/.cache/mincho` for esbuild. Set `directory` to override
it; relative overrides resolve from the Node process working directory.
`maxBytes` sets the total filesystem budget and defaults to 256 MiB. It must be
a positive safe integer. Oldest-used entries are evicted after writes.

```ts
minchoVitePlugin({
  cache: {
    type: "filesystem",
    directory: "/tmp/my-project-mincho-cache",
    maxBytes: 128 * 1024 * 1024
  }
});
```

Entries include a format version, compiler/dependency identity, Node platform
identity, and input fingerprints. Vite separates client/server environments,
commands and modes. A hit revalidates inputs and provider observations before
reusing the result. Dependency watches and native esbuild assets are replayed;
CSS evaluation and registry publication still run for each build. Opaque plugin
effects and unsupported configurations continue through the normal compiler.

Writes publish through temporary files in the destination directory and an
atomic rename. In one process, pending writes to the same path coalesce and
stale generations cannot replace a valid successor. Identical content avoids
replacing the file. Separate processes may publish complete entries concurrently;
the cache does not impose a global ordering across processes. A terminated
writer can leave a temporary file, which readers ignore. Corrupt, truncated,
incompatible or missing entries are cache misses. An unavailable cache directory
does not prevent compilation.

Only validated successful compilation sessions publish entries. This does not
make a filesystem cache a transaction across other bundler plugins or output
files. Cache data is disposable and can be removed while the compiler is stopped.
Use a directory controlled by the build user; cache entries use Node's binary
serialization format and are not an interchange format for untrusted artifacts.

Enable `diagnostics: { json: "mincho-build.json" }` to inspect `disk-cache-hit`,
`cache-hit`, invalidation and write events. A disk read alone does not prove
successful reuse: `cache-hit` records reuse after validation. No production
default change or performance improvement is claimed by this opt-in feature.
