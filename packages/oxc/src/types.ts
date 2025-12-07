/**
 * Options for OXC base transform (TypeScript and JSX only)
 */
export interface MinchoOxcBaseOptions {
  typescript?: {
    onlyRemoveTypeImports?: boolean;
    declaration?: boolean;
  };
  jsx?: {
    runtime?: "automatic" | "classic";
    development?: boolean;
    importSource?: string;
  };
  target?: "es2015" | "es2016" | "es2020" | "esnext";
  sourcemap?: boolean;
}

/**
 * Result of Mincho custom transformation
 */
export interface MinchoTransformResult {
  code: string;
  map: unknown;
  cssExtractions: Array<{
    id: string;
    content: string;
    dependencies: string[];
  }>;
  dependencies: string[];
}

/**
 * Options for Mincho custom transformation
 */
export interface MinchoTransformOptions {
  filename: string;
  sourceRoot: string;
  extractCSS?: boolean;
}

/**
 * Visitor callbacks for AST traversal
 */
export interface MinchoVisitors {
  onStyledCall?: (node: unknown, start: number, end: number) => void;
  onStyleCall?: (node: unknown, start: number, end: number) => void;
  onCSSCall?: (node: unknown, start: number, end: number) => void;
  onGlobalStyleCall?: (node: unknown, start: number, end: number) => void;
}

/**
 * CSS extraction data
 */
export interface CSSExtraction {
  id: string;
  content: string;
  dependencies: string[];
}
