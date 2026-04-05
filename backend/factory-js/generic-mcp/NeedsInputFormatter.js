function safeString(value) {
  return value == null ? "" : String(value);
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function formatNeedsInputForCli(runResult) {
  const r = isPlainObject(runResult) ? runResult : {};
  if (safeString(r.status).trim() !== "needs_input") {
    return safeString(r.presentation).trim() || "(no presentation output)";
  }
  const lines = [];
  const question = safeString(r.question).trim();
  if (question) lines.push(question);
  const kind = safeString(r.kind).trim();
  if (kind) lines.push(`Type: ${kind}`);

  const field = safeString(r.field).trim();
  if (field) lines.push(`Field: ${field}`);

  const attempted = safeString(r.attemptedValue).trim();
  if (attempted) lines.push(`Attempted value: ${attempted}`);

  const options = Array.isArray(r.options) ? r.options.filter((x) => safeString(x).trim()) : [];
  if (options.length > 0) {
    lines.push("Options:");
    for (const opt of options) lines.push(`- ${safeString(opt).trim()}`);
  }

  const args = isPlainObject(r.partialPlan?.args) ? r.partialPlan.args : null;
  if (args && Object.keys(args).length > 0) {
    lines.push(`Understood so far: ${JSON.stringify(args)}`);
  }
  return lines.join("\n");
}

