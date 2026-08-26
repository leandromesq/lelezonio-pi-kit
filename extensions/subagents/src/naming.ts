/** Session-scoped friendly names for subagents: a stable alias a follow-up
 * tool can address instead of the generated `sa-N` id. Collisions get
 * numeric suffixes; re-registering the same name for the same id keeps it. */

/** Register `desired` → `id`, suffixing on collision. Returns the final name. */
export function registerSubagentName(
  registry: Map<string, string>,
  desired: string,
  id: string,
): string {
  const base = desired.trim() || "subagent";
  let name = base;
  let n = 2;
  while (registry.has(name) && registry.get(name) !== id) {
    name = `${base}-${n++}`;
  }
  registry.set(name, id);
  return name;
}

/** Resolve a tool target: a registered name wins; otherwise it is an id. */
export function resolveSubagentTarget(
  idOrName: string,
  registry: ReadonlyMap<string, string>,
): string {
  const byName = registry.get(idOrName);
  return byName ?? idOrName;
}
