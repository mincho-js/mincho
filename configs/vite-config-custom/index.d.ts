import type { ConfigEnv, mergeConfig } from "vite";
import type { defineConfig } from "vitest/config";

type TInputConfig = Parameters<typeof defineConfig>[0];
type TOutputConfig = ReturnType<typeof mergeConfig>;

declare function UserConfig(
  viteConfigEnv: ConfigEnv,
  extendConfigs?: TInputConfig = {}
): TOutputConfig;

export declare const NodeConfig = UserConfig;
export declare const ReactConfig = UserConfig;
