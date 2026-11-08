import type { ComponentProps } from "react";
import type { RecipeVariants } from "@mincho-js/css";
import { button, cx } from "./button.css";
import { mintTheme } from "./theme.css";

type ButtonProps = ComponentProps<"button"> &
  Exclude<RecipeVariants<typeof button>, unknown[]>;

export function Button({ tone, size, className, ...props }: ButtonProps) {
  return (
    <button {...props} className={cx(button({ tone, size }), className)} />
  );
}

export function Example() {
  return (
    <div className={mintTheme}>
      <Button tone="accent" size="large">
        Grow with Mincho
      </Button>
    </div>
  );
}
