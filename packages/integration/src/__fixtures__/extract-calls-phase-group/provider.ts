const singleton = { color: "red" };
const events: string[] = [];
let calls = 0;

export function first() {
  calls++;
  events.push("first");
  return singleton;
}

export function second() {
  calls++;
  events.push("second");
  return singleton;
}

export function mutate(left: typeof singleton, right: typeof singleton) {
  calls++;
  events.push(`mutate:${left === right}`);
  left.color = "blue";
  return "changed";
}

export function finish(
  left: typeof singleton,
  right: typeof singleton,
  changed: string
) {
  calls++;
  events.push(
    `finish:${left === right}:${left.color}:${right.color}:${changed}`
  );
  return `${left === right}:${left.color}:${right.color}:${changed}|${calls}|${events.join(",")}`;
}
