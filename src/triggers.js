/**
 * triggers.js — exact-match trigger rule for the "business" comment CTA.
 *
 * Rule: trim whitespace, lowercase, strip surrounding punctuation and emoji.
 * The result must equal "business".
 *
 *   Accept: "Business", "BUSINESS!", "business.", "💪business💪"
 *   Reject: "small business", "business as usual",
 *           "Business is very difficult right now"
 * When in doubt, skip.
 */
export function normalizeTrigger(text) {
  if (typeof text !== 'string') return '';
  return (
    text
      .trim()
      .toLowerCase()
      // strip leading/trailing chars that are not letters or numbers
      // (punctuation, whitespace, emoji, symbols)
      .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  );
}

export function isTriggerComment(text) {
  return normalizeTrigger(text) === 'business';
}
