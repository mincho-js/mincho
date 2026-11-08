const tokens =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\b(?:import|from|export|const|type|function|return|true|false|null|undefined)\b|\b\d+\b)/g;

export function HighlightCode({ source }: { source: string }) {
  const code = source.trimEnd();
  const lineCount = code.split("\n").length;
  return (
    <pre className="mincho-workflow-source" tabIndex={0}>
      <span className="mincho-code-gutter" aria-hidden="true">
        {Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}
      </span>
      <code>
        {code.split(tokens).map((text, index) => {
          const kind = text.startsWith("//")
            ? "comment"
            : /^["']/.test(text)
              ? "string"
              : /^\d+$/.test(text)
                ? "number"
                : /^(import|from|export|const|type|function|return|true|false|null|undefined)$/.test(
                      text
                    )
                  ? "keyword"
                  : null;
          return kind ? (
            <span key={index} className={`token-${kind}`}>
              {text}
            </span>
          ) : (
            text
          );
        })}
      </code>
    </pre>
  );
}
