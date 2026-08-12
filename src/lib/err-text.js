/**
 * Turn any thrown value into a readable one-line description.
 *
 * Rationale: Node's connect() with autoSelectFamily rejects with an
 * AggregateError whose `message` is an empty string (the real errors live
 * in `err.errors`). Without normalization, tool surfaces would print
 * "Execution failed: " with nothing after the colon.
 *
 * @param {unknown} err
 * @returns {string}
 */
export function describeError(err) {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  if (err instanceof Error) {
    if (err.message) return err.message;
    // AggregateError and friends: dig into child errors.
    const children = Array.isArray(err.errors) ? err.errors : null;
    if (children && children.length) {
      const texts = children.map((c) => describeError(c)).filter(Boolean);
      if (texts.length) return texts.join("; ");
    }
    if (err.code) return `${err.code}${err.name && err.name !== "Error" ? ` (${err.name})` : ""}`;
    return err.name || "unknown error";
  }
  return String(err);
}
