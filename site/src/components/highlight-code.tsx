const tokens =
  /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/[^\n]*|\b(?:import|from|export|const|type|function|return|true|false|null|undefined)\b|\b\d+\b)/g;

export function HighlightCode({ source }: { source: string }) {
  return (
    <pre className="mincho-workflow-source" tabIndex={0}>
      <code>
        {source
          .trimEnd()
          .split(tokens)
          .map((text, index) => {
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
