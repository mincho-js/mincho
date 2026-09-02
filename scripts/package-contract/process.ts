import { spawn } from "node:child_process";
import { PackageContractError } from "./types.js";

type CommandOptions = {
  readonly args: readonly string[];
  readonly artifactPath?: string;
  readonly command: string;
  readonly cwd: string;
};

export async function runCommand({
  args,
  artifactPath,
  command,
  cwd
}: CommandOptions): Promise<void> {
  const rendered = [command, ...args].join(" ");
  console.log(`[package-contract] $ ${rendered}`);

  // Keep npm and the isolated consumers free of the workspace's PnP loader.
  // Workspace yarn commands inject their own loader when they need it.
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const result = await new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
    readonly stdout: string;
  }>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: "pipe" });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stderr, stdout }));
  });

  if (result.code !== 0) {
    const failure = [
      `command: ${rendered}`,
      `exit status: ${result.code ?? result.signal ?? "unknown"}`,
      `inspected artifact: ${artifactPath ?? "n/a"}`,
      result.stdout,
      result.stderr
    ]
      .filter(Boolean)
      .join("\n");
    console.error(failure);
    throw new PackageContractError(failure);
  }
}
