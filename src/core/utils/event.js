export class CommonEventEmitter {
    constructor() {
        this.listeners = new Map();
    }
    on(event, listener) {
        const set = this.listeners.get(event) ?? new Set();
        set.add(listener);
        this.listeners.set(event, set);
        return this;
    }
    once(event, listener) {
        const wrapped = ((...args) => {
            this.off(event, wrapped);
            listener(...args);
        });
        return this.on(event, wrapped);
    }
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
        return this;
    }
    emit(event, ...args) {
        for (const listener of this.listeners.get(event) ?? []) {
            listener(...args);
        }
        return this;
    }
}
