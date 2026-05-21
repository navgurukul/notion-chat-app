/** Escape `%` and `_` for safe use in SQL LIKE patterns. */
export function escapeLike(value: string) {
  return value.replace(/[%_]/g, "\\$&");
}

export function likePattern(value: string) {
  return `%${escapeLike(value)}%`;
}
