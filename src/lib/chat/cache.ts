export class SimpleCache<T> {
  private cache = new Map<string, { value: T; expiresAt: number }>();

  constructor(private ttlMs: number, private maxSize: number) {}

  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      this.cache.clear();
    }
    this.cache.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  clear(): void {
    this.cache.clear();
  }
}

// Language normalization cache: 24 hours
export const normalizationCache = new SimpleCache<string>(24 * 60 * 60 * 1000, 500);

// Query reformulation cache: 30 minutes
export const reformulationCache = new SimpleCache<string>(30 * 60 * 1000, 200);

// Embeddings cache: 24 hours
export const embeddingsCache = new SimpleCache<number[]>(24 * 60 * 60 * 1000, 1000);

// SQL metadata queries cache: 5 minutes
export const sqlMetadataCache = new SimpleCache<string>(5 * 60 * 1000, 100);

// People directory cache: 1 hour
export const peopleDirectoryCache = new SimpleCache<any>(60 * 60 * 1000, 1);
