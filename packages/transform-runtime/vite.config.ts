import type { ConfigEnv } from "vite";
import { NodeConfig } from "vite-config-custom";

export default (viteConfigEnv: ConfigEnv) => {
  return NodeConfig(viteConfigEnv);
};
