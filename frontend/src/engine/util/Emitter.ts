/**
 * Tiny typed event emitter used by the world to talk to React.
 * Listener errors are isolated so one bad subscriber can't stop the loop.
 */
export class Emitter<Events extends object> {
  private readonly listeners = new Map<
    keyof Events,
    Set<(payload: never) => void>
  >();

  on<K extends keyof Events>(
    event: K,
    cb: (payload: Events[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(cb as (payload: never) => void);
    return () => {
      set.delete(cb as (payload: never) => void);
    };
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        (cb as (p: Events[K]) => void)(payload);
      } catch (err) {
        console.error(`[world] listener for "${String(event)}" failed`, err);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}
