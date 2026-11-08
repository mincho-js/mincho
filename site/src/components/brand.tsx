import { basePath } from "../../site.config.mjs";

export function Brand() {
  return (
    <span className="mincho-wordmark">
      <img src={`${basePath}/logo.svg`} alt="" width="32" height="58" />
      <span>
        Mincho<span className="mincho-wordmark-js">.js</span>
      </span>
    </span>
  );
}
