/**
 * Threaded (pthread) wasm codecs size their worker pool from
 * `navigator.hardwareConcurrency`. `WorkerBridge` appends a `threads` query
 * parameter to the worker URL, and overriding the property here — before the
 * codec module is imported — caps how many cores a single encode may occupy.
 *
 * A single encode otherwise spreads across every core, so this is the only
 * lever that can hold a threaded codec below full CPU.
 */
export function applyThreadLimit(): void {
  let raw: string | null;
  try {
    raw = new URLSearchParams(self.location.search).get('threads');
  } catch {
    return;
  }
  if (!raw) return;

  const limit = Number(raw);
  if (!Number.isFinite(limit) || limit < 1) return;

  try {
    Object.defineProperty(navigator, 'hardwareConcurrency', {
      configurable: true,
      get: () => limit,
    });
  } catch {
    // Not overridable in this engine — the cap is skipped, encoding still works.
  }
}
