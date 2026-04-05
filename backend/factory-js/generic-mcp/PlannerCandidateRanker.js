/**
 * PlannerCandidateRanker
 * -----------------------------------------------------------------------------
 * Cheap generic ranking for planner-facing compact catalog narrowing.
 *
 * This is an optimization layer only. It must never be a correctness boundary:
 * ToolPlanner escalates from narrow -> broader -> full compact catalog.
 */

function safeString(value) {
  return value == null ? "" : String(value);
}

function tokenize(input) {
  return safeString(input)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function asSet(items) {
  return new Set(Array.isArray(items) ? items : []);
}

function overlapScore(aSet, bSet) {
  let hits = 0;
  for (const t of aSet) {
    if (bSet.has(t)) hits += 1;
  }
  return hits;
}

function hintTokensFromContext(sessionContext) {
  const hints = Array.isArray(sessionContext?.resourceRefHints)
    ? sessionContext.resourceRefHints
    : [];
  const out = [];
  for (const h of hints) {
    out.push(...tokenize(h?.ref));
    out.push(...tokenize(h?.kind));
  }
  return out;
}

function scoreEntry(entry, requestTokens, hintTokenSet) {
  const nameTokens = asSet(tokenize(entry?.name));
  const summaryTokens = asSet(tokenize(entry?.summary));
  const tagTokens = asSet((Array.isArray(entry?.tags) ? entry.tags : []).flatMap((x) => tokenize(x)));
  const slotTokens = asSet((Array.isArray(entry?.requiredSlots) ? entry.requiredSlots : []).flatMap((x) => tokenize(x)));
  const verbTokens = asSet(tokenize(entry?.verb));
  const categoryTokens = asSet(tokenize(entry?.category));

  let score = 0;
  score += overlapScore(nameTokens, requestTokens) * 4;
  score += overlapScore(tagTokens, requestTokens) * 3;
  score += overlapScore(summaryTokens, requestTokens) * 2;
  score += overlapScore(slotTokens, requestTokens) * 2;
  score += overlapScore(verbTokens, requestTokens) * 2;
  score += overlapScore(categoryTokens, requestTokens) * 2;
  score += overlapScore(nameTokens, hintTokenSet) * 2;
  score += overlapScore(tagTokens, hintTokenSet);

  // Prefer tools whose required slots the request appears to satisfy.
  const requiredSlots = Array.isArray(entry?.requiredSlots) ? entry.requiredSlots : [];
  for (const slot of requiredSlots) {
    const slotSet = asSet(tokenize(slot));
    if (overlapScore(slotSet, requestTokens) > 0 || overlapScore(slotSet, hintTokenSet) > 0) {
      score += 1;
    }
  }

  return score;
}

export function rankPlannerCatalog({ plannerCatalog = [], userRequest = "", sessionContext = null } = {}) {
  const requestTokenSet = asSet(tokenize(userRequest));
  const hintTokenSet = asSet(hintTokensFromContext(sessionContext));
  const ranked = (Array.isArray(plannerCatalog) ? plannerCatalog : [])
    .map((entry, index) => ({
      entry,
      index,
      score: scoreEntry(entry, requestTokenSet, hintTokenSet),
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return ranked;
}

export function narrowPlannerCatalog({ plannerCatalog = [], userRequest = "", sessionContext = null, limit = 12 } = {}) {
  const ranked = rankPlannerCatalog({ plannerCatalog, userRequest, sessionContext });
  const n = Math.max(1, Math.min(Number(limit) || 1, ranked.length || 1));
  return ranked.slice(0, n).map((x) => x.entry);
}

