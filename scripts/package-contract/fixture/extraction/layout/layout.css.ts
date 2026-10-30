import { hstack, stackLayout } from "@mincho-js/css/layout";

export const toolbar = hstack({ width: 400, gap: 16, padding: 24 });
export const staticLayout = stackLayout(
  { axis: "horizontal", width: 400, gap: 12 },
  [
    { id: "a", props: { width: 100, gapAfter: 20 } },
    { id: "b", props: { width: 100 } }
  ]
);
