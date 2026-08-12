export type PackageManifest = {
  readonly name: string;
  readonly version: string;
  readonly private: boolean;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly optionalDependencies: Readonly<Record<string, string>>;
  readonly exports: unknown;
  readonly files: readonly string[];
  readonly types?: string;
  readonly typings?: string;
};

export type WorkspacePackage = {
  readonly directory: string;
  readonly manifest: PackageManifest;
};

export type PackedPackage = WorkspacePackage & {
  readonly archivePath: string;
};

export class PackageContractError extends Error {
  readonly name = "PackageContractError";

  constructor(readonly detail: string) {
    super(detail);
  }
}
