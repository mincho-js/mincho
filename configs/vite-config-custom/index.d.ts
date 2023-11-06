import type { ConfigEnv, mergeConfig } from "vite";
import type { defineConfig } from "vitest/config";

type TInputConfig = Parameters<typeof defineConfig>;
type TOutputConfig = ReturnType<typeof mergeConfig>;

declare function UserConfig(
  viteConfigEnv: ConfigEnv,
  extendConfigs?: TInputConfig = {}
): TOutputConfig;

export type NodeConfig = typeof UserConfig;
export type ReactConfig = typeof UserConfig;
