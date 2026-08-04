export function extractYear(query: string): number | null {
  const explicit = query.match(/\b(20\d{2})\b/);

  if (explicit) {
    return Number(explicit[1]);
  }

  const q = query.toLowerCase();

  if (q.includes("this year")) {
    return new Date().getFullYear();
  }

  if (q.includes("last year")) {
    return new Date().getFullYear() - 1;
  }

  return null;
}