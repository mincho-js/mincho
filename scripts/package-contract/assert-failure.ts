import { PackageContractError } from "./types.js";

export function assertFailure(
  label: string,
  expectedDetail: string,
  action: () => void,
  missingFailure = "Expected failure path did not fail"
): void {
  try {
    action();
  } catch (error) {
    if (error instanceof PackageContractError) {
      if (!error.detail.includes(expectedDetail)) {
        throw new PackageContractError(
          `${label} failed with an unexpected diagnostic: ${error.detail}`
        );
      }
      return;
    }
    throw error;
  }
  throw new PackageContractError(`${missingFailure}: ${label}`);
}
