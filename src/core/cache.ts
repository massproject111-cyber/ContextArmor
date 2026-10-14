import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

export class DiskCache {
  private cacheDir: string;
  private memoryCache: Map<string, CacheEntry<unknown>> = new Map();
  private ttlMs: number;

  constructor(ttlHours = 24, ttlMinutes?: number, customDir?: string) {
    if (ttlMinutes !== undefined) {
      this.ttlMs = ttlMinutes * 60 * 1000;
    } else {
      this.ttlMs = ttlHours * 60 * 60 * 1000;
    }
    this.cacheDir = customDir || path.join(os.homedir(), '.contextarmor', 'cache');
    try {
      if (!fs.existsSync(this.cacheDir)) {
        fs.mkdirSync(this.cacheDir, { recursive: true });
      }
    } catch {
      // Fallback to in-memory only if home directory not writable
    }
  }

  public get<T>(key: string): T | null {
    const now = Date.now();
    const mem = this.memoryCache.get(key);
    if (mem) {
      if (now - mem.timestamp < this.ttlMs) {
        return mem.value as T;
      }
      this.memoryCache.delete(key);
    }

    const safeFilename = Buffer.from(key).toString('hex') + '.json';
    const filePath = path.join(this.cacheDir, safeFilename);
    if (fs.existsSync(filePath)) {
      try {
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as CacheEntry<T>;
        if (now - raw.timestamp < this.ttlMs) {
          this.memoryCache.set(key, raw);
          return raw.value;
        }
        fs.unlinkSync(filePath);
      } catch {
        // ignore parse error
      }
    }
    return null;
  }

  public set<T>(key: string, value: T): void {
    const entry: CacheEntry<T> = { value, timestamp: Date.now() };
    this.memoryCache.set(key, entry);

    const safeFilename = Buffer.from(key).toString('hex') + '.json';
    const filePath = path.join(this.cacheDir, safeFilename);
    try {
      fs.writeFileSync(filePath, JSON.stringify(entry));
    } catch {
      // In-memory fallback
    }
  }
}
