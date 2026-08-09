import type { Linter } from "eslint";
import type { InfiniteDepthConfigWithExtends } from "typescript-eslint";

export declare function eslintConfig(
  userConfigs?: InfiniteDepthConfigWithExtends,
): Linter.Config[];
