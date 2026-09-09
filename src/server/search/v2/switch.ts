type Request = (path: string, init?: RequestInit, allowedStatuses?: number[]) => Promise<Response>;

export async function readRecallAlias(request: Request, baseIndex: string) {
  const alias = `${baseIndex}_recall_read`;
  const response = await request(`/_alias/${encodeURIComponent(alias)}`, {}, [404]);
  if (response.status === 404) return null;
  const bindings = await response.json();
  const indices = Object.keys(bindings);
  if (indices.length !== 1 || !indices[0].startsWith(`${baseIndex}_recall_v2_`)) throw new Error("Recall alias is not a unique environment binding");
  const options = bindings[indices[0]]?.aliases?.[alias];
  if (!options || options.filter || options.routing || options.search_routing || options.index_routing) throw new Error("Recall alias has unexpected filter or routing");
  return indices[0];
}

/** Caller holds the environment's deployment lock and has rechecked readiness.
 * No remove_index actions and no wildcard targets; old build remains writable.
 * This changes the v2 alias only. Deploying SEARCH_RECALL_ENGINE is a separate step. */
export async function switchRecallAlias(request: Request, baseIndex: string, expected: string | null, target: string) {
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(baseIndex) || !/^[a-z0-9][a-z0-9_-]*$/.test(target) ||
    !target.startsWith(`${baseIndex}_recall_v2_`)) throw new Error("Target is outside the selected environment");
  const current = await readRecallAlias(request, baseIndex);
  if (current !== expected) throw new Error("Recall alias changed since the switch plan was prepared");
  if (current === target) return { changed: false, previous: current, current: target };
  const alias = `${baseIndex}_recall_read`;
  const actions = [
    ...(current ? [{ remove: { index: current, alias, must_exist: true } }] : []),
    { add: { index: target, alias, is_write_index: false } },
  ];
  const response = await request("/_aliases", { method: "POST", body: JSON.stringify({ actions }) });
  const result = await response.json();
  if (!result.acknowledged || result.errors) throw new Error("Alias update was not acknowledged; inspect the current binding before retrying");
  if (await readRecallAlias(request, baseIndex) !== target) throw new Error("Alias verification differs from target; inspect concurrent deployment activity");
  return { changed: true, previous: current, current: target };
}
