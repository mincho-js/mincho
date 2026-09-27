import { readFile, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";

export async function cpuTopology() {
  const available = availableParallelism();
  if (process.platform !== "linux") return { available };

  try {
    const status = await readFile("/proc/self/status", "utf8");
    const allowed = status.match(/^Cpus_allowed_list:\s*(.+)$/m)[1];
    const cores = new Set();

    for (const range of allowed.split(",")) {
      const [first, last = first] = range.split("-").map(Number);

      for (let cpu = first; cpu <= last; cpu++) {
        const directory = `/sys/devices/system/cpu/cpu${cpu}/topology`;
        cores.add(
          (await readFile(directory + "/physical_package_id", "utf8")).trim() +
            ":" +
            (await readFile(directory + "/core_id", "utf8")).trim()
        );
      }
    }

    return { available, physical: cores.size, allowed };
  } catch {
    return { available };
  }
}

/** Separate diagnostic runs only: /proc sampling adds measurable parent CPU work. */
export function observeProcessTree(root) {
  const threads = new Map();
  let peakRssMiB = 0;
  let peakThreads = 0;
  let samples = 0;
  let stopped = false;
  let pending = Promise.resolve();

  const sample = async () => {
    const pids = [root];
    const seen = new Set();
    let rss = 0,
      threadCount = 0;

    while (pids.length) {
      const pid = pids.pop();
      if (seen.has(pid)) continue;

      seen.add(pid);

      try {
        const directory = `/proc/${pid}`;
        const status = await readFile(directory + "/status", "utf8");
        rss += Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1] ?? 0) / 1024;

        const tids = await readdir(directory + "/task");
        threadCount += tids.length;

        for (const tid of tids) {
          const base = `${directory}/task/${tid}`;
          const status = await readFile(base + "/status", "utf8").catch(
            () => ""
          );

          const previous = threads.get(`${pid}:${tid}`) ?? [0, 0];
          threads.set(`${pid}:${tid}`, [
            Math.max(
              previous[0],
              Number(
                status.match(/^voluntary_ctxt_switches:\s*(\d+)/m)?.[1] ?? 0
              )
            ),
            Math.max(
              previous[1],
              Number(
                status.match(/^nonvoluntary_ctxt_switches:\s*(\d+)/m)?.[1] ?? 0
              )
            )
          ]);

          const children = await readFile(base + "/children", "utf8").catch(
            () => ""
          );

          pids.push(
            ...children.trim().split(/\s+/).filter(Boolean).map(Number)
          );
        }
      } catch {
        /* A child or thread may exit between samples. */
      }
    }

    samples++;
    peakRssMiB = Math.max(peakRssMiB, rss);
    peakThreads = Math.max(peakThreads, threadCount);
  };

  const timer = setInterval(() => {
    if (stopped) return;

    stopped = true;
    pending = sample().finally(() => {
      stopped = false;
    });
  }, 25);

  return async () => {
    clearInterval(timer);
    await pending;

    return {
      samples,
      sampledPeakRssMiB: peakRssMiB,
      peakThreads,
      voluntaryContextSwitches: [...threads.values()].reduce(
        (sum, values) => sum + values[0],
        0
      ),
      involuntaryContextSwitches: [...threads.values()].reduce(
        (sum, values) => sum + values[1],
        0
      )
    };
  };
}
