import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { availableParallelism, cpus } from "node:os";
import { dirname, posix } from "node:path";
import { promisify } from "node:util";

export interface CpuBudget {
  readonly logical: number;
  readonly available: number;
  readonly physical?: number;
  readonly quota?: number;
  readonly budget: number;
  readonly automaticWorkers: number;
  readonly source: string;
}

interface CpuProbe {
  platform: string;
  logical: number;
  available: number;

  read(path: string): Promise<string>;

  command(file: string, args: string[]): Promise<string>;
}

const execute = promisify(execFile);
let detected: Promise<CpuBudget> | undefined;

/** Detect once, lazily: launching OS utilities must not tax small builds. */
export function getCpuBudget(): Promise<CpuBudget> {
  return (detected ??= inspectCpuBudget({
    platform: process.platform,
    logical: cpus().length,
    available: availableParallelism(),

    read: (path) => readFile(path, "utf8"),

    command: async (file, args) =>
      (await execute(file, args, { timeout: 2_000, windowsHide: true })).stdout
  }));
}

export function parseCpuList(value: string): number[] {
  const cpus = new Set<number>();

  for (const range of value.trim().split(",")) {
    if (!/^\d+(?:-\d+)?$/.test(range)) throw new Error("Invalid CPU list");

    const [start, end = start] = range.split("-").map(Number);
    if (start > end || end > 1_000_000) throw new Error("Invalid CPU range");

    for (let cpu = start; cpu <= end; cpu++) cpus.add(cpu);
  }

  return [...cpus];
}

async function optionalRead(probe: CpuProbe, path: string) {
  try {
    return await probe.read(path);
  } catch {
    return undefined;
  }
}

/** Account for both nested cgroups and mount roots in container namespaces. */
async function linuxQuota(probe: CpuProbe): Promise<number | undefined> {
  const [groups, mounts] = await Promise.all([
    optionalRead(probe, "/proc/self/cgroup"),
    optionalRead(probe, "/proc/self/mountinfo")
  ]);
  if (!groups || !mounts) return undefined;

  const quotas: number[] = [];

  for (const mount of mounts.trim().split("\n")) {
    const [left, right] = mount.split(" - ");
    if (!right) continue;

    const [type, , controllers = ""] = right.split(" ");
    if (
      type !== "cgroup2" &&
      !(type === "cgroup" && controllers.split(",").includes("cpu"))
    )
      continue;

    const fields = left.split(" ");

    const unescape = (path: string) =>
      path.replace(/\\([0-7]{3})/g, (_, code: string) =>
        String.fromCharCode(parseInt(code, 8))
      );

    const root = unescape(fields[3]);
    const mountPath = unescape(fields[4]);

    for (const group of groups.trim().split("\n")) {
      const [, names, path] = group.split(":");
      if (
        type === "cgroup2" ? names !== "" : !names?.split(",").includes("cpu")
      )
        continue;
      if (!path) continue;

      // In a cgroup namespace /proc can be relative to a host-rooted mount.
      const relative =
        root === "/" || path === root || path.startsWith(root + "/")
          ? posix.relative(root, path)
          : path;

      let directory = posix.join(mountPath, relative);

      while (directory === mountPath || directory.startsWith(mountPath + "/")) {
        const values =
          type === "cgroup2"
            ? (await optionalRead(probe, posix.join(directory, "cpu.max")))
                ?.trim()
                .split(/\s+/)
            : await Promise.all([
                optionalRead(probe, posix.join(directory, "cpu.cfs_quota_us")),
                optionalRead(probe, posix.join(directory, "cpu.cfs_period_us"))
              ]);

        const [quota, period] = values?.map(Number) ?? [];

        if (quota > 0 && period > 0) quotas.push(quota / period);
        if (directory === mountPath) break;

        directory = dirname(directory);
      }
    }
  }

  return quotas.length ? Math.min(...quotas) : undefined;
}

/** OS topology is not inferred by dividing the logical count by two. */
export async function inspectCpuBudget(probe: CpuProbe): Promise<CpuBudget> {
  const available = Math.max(1, Math.floor(probe.available));
  let physical: number | undefined;
  let quota: number | undefined;
  let source = "unavailable";

  try {
    if (probe.platform === "linux") {
      quota = await linuxQuota(probe);

      const status = await probe.read("/proc/self/status");
      const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
      if (!allowed) throw new Error("CPU affinity unavailable");

      const onlineList = await optionalRead(
        probe,
        "/sys/devices/system/cpu/online"
      );
      const online =
        onlineList === undefined
          ? undefined
          : new Set(parseCpuList(onlineList));
      const cores = new Set<string>();

      for (const cpu of parseCpuList(allowed)) {
        if (online && !online.has(cpu)) continue;

        const path = `/sys/devices/system/cpu/cpu${cpu}/topology`;
        const [socket, core] = await Promise.all([
          probe.read(`${path}/physical_package_id`),
          probe.read(`${path}/core_id`)
        ]);
        if (![socket, core].every((id) => /^\d+$/.test(id.trim())))
          throw new Error("CPU topology unavailable");

        cores.add(`${socket.trim()}:${core.trim()}`);
      }

      if (!cores.size) throw new Error("CPU topology is unavailable");

      physical = cores.size;
      source = "linux-affinity-topology";
    } else if (probe.platform === "darwin") {
      const count = Number(
        await probe.command("/usr/sbin/sysctl", ["-n", "hw.physicalcpu"])
      );

      // A restricted SMT affinity cannot be mapped from aggregate counts.
      if (available >= probe.logical || count === probe.logical) {
        physical = Math.min(count, available);
        source = "darwin-sysctl";
      }
    } else if (probe.platform === "win32") {
      const data = JSON.parse(
        await probe.command("powershell.exe", [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Processor | Select-Object NumberOfCores,NumberOfLogicalProcessors | ConvertTo-Json -Compress"
        ])
      ) as
        | { NumberOfCores: number; NumberOfLogicalProcessors: number }
        | { NumberOfCores: number; NumberOfLogicalProcessors: number }[];

      const processors = Array.isArray(data) ? data : [data];
      const count = processors.reduce(
        (total, cpu) => total + cpu.NumberOfCores,
        0
      );

      const logical = processors.reduce(
        (total, cpu) => total + cpu.NumberOfLogicalProcessors,
        0
      );

      if (available >= logical || count === logical) {
        physical = Math.min(count, available);
        source = "windows-cim";
      }
    }
  } catch {
    physical = undefined;
    source = "unavailable";
  }

  if (!Number.isSafeInteger(physical) || physical! < 1) physical = undefined;

  const budget = Math.min(
    available,
    physical ?? available,
    quota === undefined ? available : Math.max(1, Math.floor(quota))
  );

  return {
    logical: probe.logical,
    available,
    physical,
    quota,
    budget,
    automaticWorkers: physical === undefined ? 0 : Math.max(0, budget - 1),
    source
  };
}
