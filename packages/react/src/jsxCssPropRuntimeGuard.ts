const missedTransformErrorMessage =
  "Mincho JSX css prop was not compiled. Enable the Mincho transform with jsxCssProp: true and ensure it runs before React JSX transform.";

export { missedTransformErrorMessage };

export function throwForOwnCssProp(props: unknown) {
  if (hasOwnCssProp(props)) {
    throw new Error(missedTransformErrorMessage);
  }
}

export function hasOwnCssProp(props: unknown): boolean {
  return (
    typeof props === "object" &&
    props !== null &&
    Object.prototype.hasOwnProperty.call(props, "css")
  );
}
