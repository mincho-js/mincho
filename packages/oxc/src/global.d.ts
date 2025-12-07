/**
 * Type declarations for oxc packages
 */

declare module "oxc-transform" {
  export interface TransformOptions {
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

  export interface TransformResult {
    code: string;
    map?: unknown;
  }

  export function transform(
    filename: string,
    sourceText: string,
    options?: TransformOptions
  ): TransformResult;

  export function transformAsync(
    filename: string,
    sourceText: string,
    options?: TransformOptions
  ): Promise<TransformResult>;
}

declare module "oxc-parser" {
  export interface ParseOptions {
    sourceType?: "script" | "module";
    preserveParens?: boolean;
  }

  export interface ParseError {
    message: string;
    labels?: Array<{ message: string }>;
  }

  export interface ParseResult {
    program: Program;
    errors: ParseError[];
  }

  export interface Program {
    type: "Program";
    body: unknown[];
    [key: string]: unknown;
  }

  export function parseSync(
    filename: string,
    sourceText: string,
    options?: ParseOptions
  ): ParseResult;

  export function parseAsync(
    filename: string,
    sourceText: string,
    options?: ParseOptions
  ): Promise<ParseResult>;
}
