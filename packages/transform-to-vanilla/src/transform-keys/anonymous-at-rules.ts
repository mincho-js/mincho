export function anonymouseKeyInfo(keyStr: string) {
  const isAnimationName = isAnonyMouseSymbol("animationName", keyStr);
  const isFontFamily = isAnonyMouseSymbol("fontFamily", keyStr);

  return {
    isAnimationName,
    isFontFamily,
    isAnonyMouseSymbol: isAnimationName || isFontFamily
  };
}

function isAnonyMouseSymbol(anonymousKey: string, keyStr: string) {
  return (
    keyStr === anonymousKey ||
    keyStr === `${anonymousKey}$` ||
    keyStr === `${anonymousKey}_`
  );
}
