import { describe, expect, it } from "vitest";
import { inspectCpuBudget, parseCpuList } from "./cpuBudget.js";

function linux(
  allowed: string,
  topology: [number, number][],
  extra: Record<string, string> = {},
  available = parseCpuList(allowed).length
) {
  const files: Record<string, string> = {
    "/proc/self/status": `Cpus_allowed_list:\t${allowed}\n`,
    ...extra
  };

  topology.forEach(([socket, core], cpu) => {
    files[`/sys/devices/system/cpu/cpu${cpu}/topology/physical_package_id`] =
      String(socket);
    files[`/sys/devices/system/cpu/cpu${cpu}/topology/core_id`] = String(core);
  });

  return inspectCpuBudget({
    platform: "linux",
    logical: topology.length,
    available,

    read: async (path) => {
      if (!(path in files)) throw new Error("missing");

      return files[path];
    },

    command: async () => {
      throw new Error("unexpected command");
    }
  });
}

describe("physical CPU budgets", () => {
  it("ignores offline CPUs without topology files in the affinity mask", async () => {
    expect(
      await linux(
        "0-3",
        [
          [0, 0],
          [0, 1]
        ],
        { "/sys/devices/system/cpu/online": "0-1" },
        2
      )
    ).toMatchObject({
      available: 2,
      physical: 2,
      budget: 2,
      automaticWorkers: 1,
      source: "linux-affinity-topology"
    });
  });

  it("counts only online, allowed physical cores when topology files remain", async () => {
    expect(
      await linux(
        "0,2-4",
        [
          [0, 0],
          [0, 1],
          [0, 0],
          [0, 2],
          [1, 0]
        ],
        { "/sys/devices/system/cpu/online": "0-2,4" },
        3
      )
    ).toMatchObject({ physical: 2, budget: 2, automaticWorkers: 1 });
  });

  it("still rejects malformed topology for an online, allowed CPU", async () => {
    expect(
      await linux(
        "0-1",
        [
          [0, 0],
          [0, Number.NaN]
        ],
        { "/sys/devices/system/cpu/online": "0-1" }
      )
    ).toMatchObject({
      physical: undefined,
      automaticWorkers: 0,
      source: "unavailable"
    });
  });

  it.each(["invalid", "4-5"])(
    "keeps automatic workers disabled for unusable online CPUs: %s",
    async (online) => {
      expect(
        await linux(
          "0-1",
          [
            [0, 0],
            [0, 1]
          ],
          { "/sys/devices/system/cpu/online": online }
        )
      ).toMatchObject({
        physical: undefined,
        automaticWorkers: 0,
        source: "unavailable"
      });
    }
  );

  it("deduplicates SMT siblings within allowed affinity, across sockets", async () => {
    const topology: [number, number][] = [
      [0, 0],
      [0, 1],
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 0]
    ];

    expect(await linux("0-5", topology)).toMatchObject({
      logical: 6,
      available: 6,
      physical: 3,
      automaticWorkers: 2
    });
    expect(await linux("0,2,5", topology)).toMatchObject({
      available: 3,
      physical: 2,
      automaticWorkers: 1
    });
    expect(await linux("1,3", topology)).toMatchObject({
      available: 2,
      physical: 1,
      automaticWorkers: 0
    });
  });

  it("does not halve systems without SMT", async () => {
    expect(
      await linux("0-3", [
        [0, 0],
        [0, 1],
        [0, 2],
        [0, 3]
      ])
    ).toMatchObject({ physical: 4, automaticWorkers: 3 });
  });

  it("applies the tightest v2 ancestor quota, including fractional allocations", async () => {
    const files = {
      "/proc/self/cgroup": "0::/tenant/app",
      "/proc/self/mountinfo":
        "1 2 0:1 /tenant /sys/fs/cgroup rw - cgroup2 cgroup rw",
      "/sys/fs/cgroup/app/cpu.max": "350000 100000",
      "/sys/fs/cgroup/cpu.max": "250000 100000"
    };

    expect(
      await linux(
        "0-3",
        [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3]
        ],
        files
      )
    ).toMatchObject({
      physical: 4,
      quota: 2.5,
      budget: 2,
      automaticWorkers: 1
    });

    files["/sys/fs/cgroup/cpu.max"] = "50000 100000";

    expect(
      await linux(
        "0-3",
        [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3]
        ],
        files
      )
    ).toMatchObject({ budget: 1, automaticWorkers: 0 });
  });

  it("reads v1 cpu,cpuacct mounts and ignores unlimited quota", async () => {
    expect(
      await linux(
        "0-3",
        [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3]
        ],
        {
          "/proc/self/cgroup": "3:cpu,cpuacct:/job",
          "/proc/self/mountinfo":
            "1 2 0:1 / /sys/fs/cgroup/cpu rw - cgroup cgroup rw,cpu,cpuacct",
          "/sys/fs/cgroup/cpu/job/cpu.cfs_quota_us": "100000",
          "/sys/fs/cgroup/cpu/job/cpu.cfs_period_us": "100000",
          "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "-1",
          "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000"
        }
      )
    ).toMatchObject({ budget: 1, automaticWorkers: 0 });
  });

  it("reads a namespace-relative group under a host-rooted mount", async () => {
    expect(
      await linux(
        "0-3",
        [
          [0, 0],
          [0, 1],
          [0, 2],
          [0, 3]
        ],
        {
          "/proc/self/cgroup": "0::/",
          "/proc/self/mountinfo":
            "1 2 0:1 /containers/job /sys/fs/cgroup rw - cgroup2 cgroup rw",
          "/sys/fs/cgroup/cpu.max": "150000 100000"
        }
      )
    ).toMatchObject({ quota: 1.5, budget: 1, automaticWorkers: 0 });
  });

  it("keeps explicit capacity but disables automatic workers when topology is unknown", async () => {
    expect(
      await inspectCpuBudget({
        platform: "linux",
        available: 8,
        logical: 8,

        read: async () => {
          throw new Error("denied");
        },

        command: async () => ""
      })
    ).toMatchObject({
      physical: undefined,
      budget: 8,
      automaticWorkers: 0,
      source: "unavailable"
    });
  });

  it("refuses to infer a restricted SMT affinity from aggregate OS counts", async () => {
    for (const platform of ["darwin", "win32"]) {
      const probe = {
        platform,
        available: 8,
        logical: 8,

        read: async () => "",

        command: async () =>
          platform === "darwin"
            ? "4"
            : '[{"NumberOfCores":4,"NumberOfLogicalProcessors":8}]'
      };

      expect(await inspectCpuBudget(probe)).toMatchObject({
        physical: 4,
        automaticWorkers: 3
      });
      expect(await inspectCpuBudget({ ...probe, available: 4 })).toMatchObject({
        physical: undefined,
        automaticWorkers: 0
      });
    }
  });
});
