import {
  SharedExampleCard,
  sharedCardClassName
} from "@examples/shared-component";
import { local as diamondLocal } from "@mincho-js-proof/diamond-d";
import "@mincho-js-proof/diamond-a/style.css";
import "@mincho-js-proof/diamond-b/style.css";
import "@mincho-js-proof/diamond-c/style.css";
import "@mincho-js-proof/diamond-d/style.css";
import { card, local, preset } from "./dynamic.css.js";

export { preset };
export const diamondDLocal = diamondLocal;
export { SharedExampleCard, sharedCardClassName };
export function dynamicCx(enabled: boolean): string {
  return local.cx(card, enabled && "package-contract-enabled");
}
