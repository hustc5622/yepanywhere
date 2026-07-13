/**
 * Node 22+ ships a built-in localStorage global accessor. Without
 * --localstorage-file it returns an empty object whose setItem/getItem are
 * undefined, which shadows the proper Storage that jsdom installs. This setup
 * file detects that broken state and replaces localStorage with a minimal
 * in-memory Storage so jsdom-based tests work across Node.js versions.
 */
class MemoryStorage {
  private readonly data = new Map<string, string>();

  get length(): number {
    return this.data.size;
  }

  clear(): void {
    this.data.clear();
  }

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) ?? null) : null;
  }

  key(index: number): string | null {
    return Array.from(this.data.keys())[index] ?? null;
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  setItem(key: string, value: string): void {
    this.data.set(key, String(value));
  }
}

if (
  typeof globalThis.localStorage !== "undefined" &&
  typeof globalThis.localStorage?.setItem !== "function"
) {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
}
