import * as vitest from "vitest";
import { registerPartialEvalDeoptReasonTests } from "./deoptReasons.js";
import { setPartialEvalTestExpect } from "./helpers.js";
import { registerPartialEvalLiteralTests } from "./literals.js";
import { registerPartialEvalOperatorTests } from "./operators.js";
import { registerPartialEvalResultTests } from "./result.js";
import { registerPartialEvalSpreadKeyPrimitiveTests } from "./spreadKeys.js";
import { registerPartialEvalStructureTests } from "./structures.js";

setPartialEvalTestExpect(vitest.expect);
registerPartialEvalDeoptReasonTests(vitest);
registerPartialEvalLiteralTests(vitest);
registerPartialEvalOperatorTests(vitest);
registerPartialEvalResultTests(vitest);
registerPartialEvalSpreadKeyPrimitiveTests(vitest);
registerPartialEvalStructureTests(vitest);
