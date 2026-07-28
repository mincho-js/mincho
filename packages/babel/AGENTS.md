# @mincho-js/babel

## OVERVIEW

Babel plugin that hoists style calls and rewrites styled().

## STRUCTURE

packages/babel/
├── src/index.ts
├── src/styled.ts
└── src/transforms/ # AST transforms

## WHERE TO LOOK

| Task           | Location                         | Notes                 |
| -------------- | -------------------------------- | --------------------- |
| Plugin entry   | `packages/babel/src/index.ts`    | registers transforms  |
| styled rewrite | `packages/babel/src/styled.ts`   | converts to $$styled  |
| Hoisting logic | `packages/babel/src/transforms/` | extraction transforms |

## CONVENTIONS

- Keep transformations deterministic and order-safe.
- Tests are colocated in source.

## ANTI-PATTERNS

- Avoid runtime logic; everything should compile away.
- Do not add ad-hoc extraction APIs without updating shared lists.
