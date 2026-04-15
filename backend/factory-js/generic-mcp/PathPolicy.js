/**
 * PathPolicy
 * -----------------------------------------------------------------------------
 * Generic provenance + existence policy for path-like args.
 *
 * Existing refs and new paths are different categories:
 * - Existing refs (`must_exist`) should be resolved against project index.
 * - Synthesized/create-intent paths (`may_not_exist_yet`) are output targets and
 *   must not fail resolution just because they do not exist before execution.
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function normalizeKey(key) {
  return safeString(key).toLowerCase().replace(/[^a-z0-9_]/g, "");
}

export function isPathLikeArg(argKey) {
  const nk = normalizeKey(argKey);
  if (!nk) return false;
  if (nk.includes("nodepath") || nk.includes("parentpath") || nk.includes("targetnode")) return false;
  return nk.endsWith("path") || nk.includes("filepath") || nk.includes("scenepath") || nk.includes("resourcepath") || nk.includes("scriptpath");
}

export function isExplicitOutputPathArg(argKey) {
  const nk = normalizeKey(argKey);
  if (!nk) return false;
  return (
    nk.includes("outputpath") ||
    nk.includes("outputfile") ||
    nk.includes("outfile") ||
    nk.includes("destinationpath") ||
    nk.includes("destinationfile") ||
    nk.includes("destination") ||
    nk.includes("exportpath") ||
    nk.includes("buildpath") ||
    nk.includes("savepath") ||
    nk.includes("targetfile")
  );
}

export function defaultPathPolicyForArg(argKey, _args, { synthesized = false, sessionInjected = false } = {}) {
  const nk = normalizeKey(argKey);
  if (sessionInjected) {
    return { provenance: "session_injected", existencePolicy: "must_exist" };
  }
  if (synthesized) {
    return { provenance: "synthesized_new_path", existencePolicy: "may_not_exist_yet" };
  }
  if (!isPathLikeArg(nk)) {
    return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
  }
  if (isExplicitOutputPathArg(argKey)) {
    return { provenance: "explicit_output_path", existencePolicy: "may_not_exist_yet" };
  }
  return { provenance: "user_supplied_exact_path", existencePolicy: "must_exist" };
}
