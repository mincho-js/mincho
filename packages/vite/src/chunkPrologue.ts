type TriviaEnd = {
  readonly index: number;
  readonly sawLineTerminator: boolean;
};

function skipTrivia(source: string, start: number): TriviaEnd {
  let index = start;
  let sawLineTerminator = false;

  while (index < source.length) {
    const character = source[index];
    if (
      character === " " ||
      character === "\t" ||
      character === "\v" ||
      character === "\f"
    ) {
      index += 1;
      continue;
    }
    if (
      character === "\n" ||
      character === "\r" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
      sawLineTerminator = true;
      index += 1;
      continue;
    }
    if (source.startsWith("//", index)) {
      index += 2;
      while (
        index < source.length &&
        source[index] !== "\n" &&
        source[index] !== "\r" &&
        source[index] !== "\u2028" &&
        source[index] !== "\u2029"
      ) {
        index += 1;
      }
      continue;
    }
    if (source.startsWith("/*", index)) {
      const commentEnd = source.indexOf("*/", index + 2);
      const end = commentEnd === -1 ? source.length : commentEnd + 2;
      if (/\r|\n|\u2028|\u2029/u.test(source.slice(index, end))) {
        sawLineTerminator = true;
      }
      index = end;
      continue;
    }
    break;
  }

  return { index, sawLineTerminator };
}

function quotedStringEnd(source: string, start: number): number | undefined {
  const quote = source[start];
  if (quote !== '"' && quote !== "'") return;

  let index = start + 1;
  while (index < source.length) {
    const character = source[index];
    if (character === quote) return index + 1;
    if (character === "\\") {
      index += source[index + 1] === "\r" && source[index + 2] === "\n" ? 3 : 2;
      continue;
    }
    if (
      character === "\n" ||
      character === "\r" ||
      character === "\u2028" ||
      character === "\u2029"
    ) {
      return;
    }
    index += 1;
  }
}

function continuesStringExpression(source: string, index: number): boolean {
  const character = source[index];
  return (
    character === "." ||
    character === "[" ||
    character === "(" ||
    character === "`" ||
    character === "?" ||
    character === "+" ||
    character === "-" ||
    character === "*" ||
    character === "/" ||
    character === "%" ||
    character === "<" ||
    character === ">" ||
    character === "=" ||
    character === "!" ||
    character === "&" ||
    character === "|" ||
    character === "^" ||
    character === "," ||
    /^(?:in|instanceof)\b/u.test(source.slice(index))
  );
}

export function findChunkDirectivePrologueEnd(source: string): number {
  let index = source.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (source.startsWith("#!", index)) {
    const lineEnd = source.indexOf("\n", index + 2);
    index = lineEnd === -1 ? source.length : lineEnd + 1;
  }

  while (true) {
    index = skipTrivia(source, index).index;
    const literalEnd = quotedStringEnd(source, index);
    if (literalEnd === undefined) return index;

    const afterLiteral = skipTrivia(source, literalEnd);
    if (source[afterLiteral.index] === ";") {
      index = skipTrivia(source, afterLiteral.index + 1).index;
      continue;
    }
    if (
      (afterLiteral.index === source.length ||
        afterLiteral.sawLineTerminator) &&
      !continuesStringExpression(source, afterLiteral.index)
    ) {
      index = afterLiteral.index;
      continue;
    }
    return index;
  }
}
