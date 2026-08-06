/**
 * Escape a value for safe use inside a SQL LIKE pattern with ESCAPE '\'.
 *
 * FIX: previously only escaped `%` and `_`, never the backslash itself. Since
 * every LIKE clause in this codebase uses `ESCAPE '\\'`, backslash IS the
 * escape character — leaving a literal backslash in the input un-escaped
 * meant it silently combined with whatever character followed it during
 * Postgres's escape parsing, in the worst case turning a following `%` into
 * an unescaped (and therefore live) wildcard instead of a literal percent
 * sign. Order matters: backslashes must be escaped first, before %/_, or the
 * backslashes this function inserts for %/_ would themselves need escaping.
 */
export function escapeLike(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
}

export function likePattern(value: string) {
  return `%${escapeLike(value)}%`;
}