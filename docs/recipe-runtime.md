# Runtime optimizations

Mincho reduces runtime work only when the compiler can establish the required
bindings, inputs and observable uses. Unproven calls keep the runtime path. CSS
rule emission order is unchanged by the JavaScript optimizations.

## Recipe order: breaking change

Recipe classes now use this order regardless of the argument object's key order:

1. Base classes.
2. Selected variants in `Object.keys(mergedVariantClassNames)` order, including
   toggles. This is also the order returned by `.variants()`.
3. Matching compounds in their declaration order.

Defaults, nullish fallback, array last-write-wins selection and strict compound
equality remain unchanged. For example, `true` and `"true"` can select the same
variant class but remain distinct compound conditions. There is no legacy-order
option. This change does not reorder emitted CSS.

`defineRules.cx` still resolves conflicts by the last input class. Passing a
recipe result to it therefore uses the new canonical recipe class order.
