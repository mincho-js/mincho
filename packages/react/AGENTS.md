# @mincho-js/react

## OVERVIEW

React bindings; styled() is a macro rewritten by Babel into runtime calls.

## STRUCTURE

packages/react/
├── src/index.ts # public types + placeholder styled
├── src/runtime.ts # $$styled runtime implementation
└── runtime/ # proxy package.json for subpath export

## WHERE TO LOOK

| Task             | Location                              | Notes                    |
| ---------------- | ------------------------------------- | ------------------------ |
| Public API types | `packages/react/src/index.ts`         | styled overloads         |
| Runtime behavior | `packages/react/src/runtime.ts`       | $$styled implementation  |
| Subpath export   | `packages/react/runtime/package.json` | @mincho-js/react/runtime |

## CONVENTIONS

- styled in index.ts is a placeholder; Babel rewrites it to $$styled.
- Keep runtime lean; most logic should compile away.
- Tests are colocated in source.

## ANTI-PATTERNS

- Do not call styled() without the Babel transform in the toolchain.
- Avoid heavy runtime dependencies here.
