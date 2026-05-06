export class CommonEventEmitter<TEvents extends Record<string, (...args: any[]) => any>> {
  private listeners = new Map<keyof TEvents, Set<(...args: any[]) => void>>();

  on<TKey extends keyof TEvents>(event: TKey, listener: TEvents[TKey]): this {
    const set = this.listeners.get(event) ?? new Set<(...args: any[]) => void>();
    set.add(listener as (...args: any[]) => void);
    this.listeners.set(event, set);
    return this;
  }

  once<TKey extends keyof TEvents>(event: TKey, listener: TEvents[TKey]): this {
    const wrapped = ((...args: Parameters<TEvents[TKey]>) => {
      this.off(event, wrapped as TEvents[TKey]);
      (listener as (...args: Parameters<TEvents[TKey]>) => void)(...args);
    }) as TEvents[TKey];

    return this.on(event, wrapped);
  }

  off<TKey extends keyof TEvents>(event: TKey, listener: TEvents[TKey]): this {
    this.listeners.get(event)?.delete(listener as (...args: any[]) => void);
    return this;
  }

  emit<TKey extends keyof TEvents>(event: TKey, ...args: Parameters<TEvents[TKey]>): this {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
    return this;
  }
}
