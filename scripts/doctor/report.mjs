import { isAbsolute, relative, resolve } from "node:path";

function key(diagnostic) {
  return JSON.stringify([
    diagnostic.file,
    diagnostic.type,
    diagnostic.message,
    diagnostic.source
  ]);
}

function isDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export function formatDecision({ kind, id, message }) {
  return `${kind}${id ? ` [${id}]` : ""} ${message}`;
}

export function reviewDoctor({
  stdout,
  status,
  signal,
  root,
  exceptions,
  readSource,
  today = new Date().toISOString().slice(0, 10)
}) {
  if (!isDate(today))
    throw new Error("Invalid review date (expected YYYY-MM-DD)");
  const failures = [];
  const decisions = [];
  const fail = (kind, message, id) => {
    const decision = { kind, id, message };
    decisions.push(decision);
    failures.push(formatDecision(decision));
  };
  const counts = new Map();
  const rules = new Map();
  const ids = new Set();
  for (const rule of exceptions) {
    if (
      typeof rule.id !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(rule.id) ||
      typeof rule.file !== "string" ||
      isAbsolute(rule.file) ||
      rule.file.split("/").includes("..") ||
      !["error", "warning"].includes(rule.type) ||
      ![rule.file, rule.message, rule.source, rule.reason].every(
        (value) => typeof value === "string" && value.trim().length > 0
      ) ||
      !Number.isInteger(rule.count) ||
      rule.count < 1
    ) {
      throw new Error(
        "Every Doctor exception needs an id, exact file, diagnostic, source, count, and reason"
      );
    }
    if (ids.has(rule.id))
      throw new Error(`Duplicate Doctor exception id: ${rule.id}`);
    ids.add(rule.id);
    if (rule.expires != null && !isDate(rule.expires)) {
      throw new Error(
        `${rule.id}: invalid expires date (expected a valid YYYY-MM-DD)`
      );
    }
    const matchKey = key(rule);
    if (rules.has(matchKey)) {
      throw Object.assign(
        new Error(
          `Rules ${rules.get(matchKey).id} and ${rule.id} match the same diagnostic in ${rule.file}`
        ),
        { code: "AMBIGUOUS" }
      );
    }
    const expired = rule.expires != null && rule.expires < today;
    rules.set(matchKey, { ...rule, expired });
    counts.set(matchKey, 0);
    if (expired)
      fail(
        "EXPIRED",
        `${rule.file}: expired ${rule.expires} (review date ${today} UTC)`,
        rule.id
      );
  }

  const events = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
  const summaries = events.filter((event) => event.type === "summary");
  const summary = summaries[0];
  if (
    summaries.length !== 1 ||
    events.at(-1) !== summary ||
    !Number.isInteger(summary.workspaces) ||
    summary.workspaces < 1 ||
    !Number.isInteger(summary.files) ||
    summary.files < 1
  )
    fail("ERROR", "Doctor did not complete a nonempty workspace scan");

  let errors = 0;
  let accepted = 0;
  for (const event of events) {
    if (event.type === "summary") continue;
    if (
      !["info", "warning", "error"].includes(event.type) ||
      typeof event.data !== "string"
    ) {
      fail("ERROR", "Unexpected Doctor report record");
      continue;
    }
    if (event.type === "info") continue;
    if (event.type === "error") errors += 1;

    const match = /^(.*):(\d+):(\d+): (.+)$/.exec(event.data);
    if (!match) {
      fail("NEW", event.data);
      continue;
    }
    const [, location, line, , message] = match;
    const file = relative(root, resolve(location)).replaceAll("\\", "/");
    if (file.startsWith("../") || isAbsolute(file)) {
      fail("NEW", event.data);
      continue;
    }
    let contents;
    try {
      contents = readSource(file);
    } catch {
      fail("NEW", `${file}:${line}: ${message} (could not read source)`);
      continue;
    }
    const source = contents.split(/\r?\n/)[Number(line) - 1]?.trim();
    const id = key({ file, type: event.type, message, source });
    const rule = rules.get(id);
    if (!rule || rule.expired) {
      fail("NEW", `${file}:${line}: ${message}`);
      continue;
    }
    counts.set(id, counts.get(id) + 1);
    accepted += 1;
    decisions.push({
      kind: "ALLOW",
      id: rule.id,
      message: `${file}:${line}: ${message}`
    });
  }

  for (const [id, rule] of rules) {
    if (rule.expired) continue;
    if (counts.get(id) !== rule.count) {
      fail(
        counts.get(id) > rule.count ? "BROAD" : "STALE",
        `Exception count changed for ${rule.file}: ${rule.message} (expected ${rule.count}, received ${counts.get(id)})`,
        rule.id
      );
    }
  }
  if (signal || ![0, 1].includes(status) || (status === 1) !== errors > 0) {
    fail(
      "ERROR",
      `Doctor exited unexpectedly (status ${status}, signal ${signal ?? "none"})`
    );
  }
  return { failures, accepted, summary, decisions };
}
