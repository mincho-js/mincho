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
  map: any;
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
  onStyledCall?: (node: any, start: number, end: number) => void;
  onStyleCall?: (node: any, start: number, end: number) => void;
  onCSSCall?: (node: any, start: number, end: number) => void;
  onGlobalStyleCall?: (node: any, start: number, end: number) => void;
}

/**
 * CSS extraction data
 */
export interface CSSExtraction {
  id: string;
  content: string;
  dependencies: string[];
}




