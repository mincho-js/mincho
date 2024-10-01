export function className(...debugIds: string[]) {
  const hashRegex = "[a-zA-Z0-9]+";
  const classStr = debugIds.map((id) => `${id}__${hashRegex}`).join(" ");
  return new RegExp(`^${classStr}$`);
}
