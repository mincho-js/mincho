export function simplyImportant(value: string) {
  return value.endsWith("!")
    ? value.endsWith(" !")
      ? `${value}important`
      : `${value.substring(0, value.length - 1)} !important`
    : value;
}

// in-source test suites
if (import.meta.vitest) {
  const { it, expect } = import.meta.vitest;

  it("simple", () => {
    expect(simplyImportant("red")).toBe("red");
    expect(simplyImportant("red!")).toBe("red !important");
    expect(simplyImportant("red !")).toBe("red !important");
  });
}
