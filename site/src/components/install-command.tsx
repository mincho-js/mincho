"use client";

import { useEffect, useRef, useState } from "react";
import { useLingui } from "@lingui/react";

const command =
  "npm install @mincho-js/css @mincho-js/vite @vanilla-extract/css";

export function InstallCommand() {
  const { i18n } = useLingui();
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timeout.current) clearTimeout(timeout.current);
    },
    []
  );

  async function copy() {
    if (timeout.current) clearTimeout(timeout.current);
    try {
      await navigator.clipboard.writeText(command);
      setStatus("copied");
    } catch {
      setStatus("error");
    }
    timeout.current = setTimeout(() => setStatus("idle"), 3500);
  }

  return (
    <div className="mincho-install-command">
      <div className="mincho-terminal-title">
        <span>npm</span>
        <button type="button" onClick={copy}>
          {status === "copied"
            ? i18n._({ id: "install.copied", message: "Copied" })
            : i18n._({ id: "install.copy", message: "Copy command" })}
          <svg
            width="16"
            height="16"
            viewBox="0 0 20 20"
            fill="none"
            aria-hidden="true"
          >
            <rect
              x="7"
              y="7"
              width="10"
              height="10"
              rx="1"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path d="M13 4V3H3v10h1" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <pre>
        <code>
          <span aria-hidden="true">$ </span>
          {command}
        </code>
      </pre>
      <p className="mincho-copy-status" role="status">
        {status === "error" &&
          i18n._({
            id: "install.copyError",
            message: "Select the command above to copy it manually."
          })}
        {status === "copied" &&
          i18n._({
            id: "install.copySuccess",
            message: "Command copied to clipboard."
          })}
      </p>
    </div>
  );
}
