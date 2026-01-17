/**
 * Shared type definitions for Mincho Vite plugins
 */

export interface Module {
  lastHMRTimestamp?: number;
  lastInvalidationTimestamp?: number;
}

export interface ViteDevServer {
  moduleGraph: {
    getModuleById: (id: string) => Module;
    invalidateModule: (module: Module) => void;
  };
}

export interface ResolvedConfig {
  root: string;
  command: string;
  mode: string;
  build: {
    watch: boolean;
  };
}

export interface PluginContext {
  addWatchFile: (id: string) => void;
}

export interface Plugin {
  name: string;
  enforce?: string;
  buildStart?: () => void;
  configureServer?: (server: ViteDevServer) => void;
  configResolved?: (config: ResolvedConfig) => void;
  resolveId?: (id: string, importer?: string) => string | undefined;
  load?: (id: string) => unknown;
  transform?: (code: string, id: string) => unknown;
}
