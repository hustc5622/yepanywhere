export interface FeishuScopeSchedulerOptions<Message, Result> {
  debounceMs?: number;
  onMessageBatch(scopeKey: string, messages: Message[]): Promise<Result>;
}

export interface FeishuControlOptions {
  priority?: "normal" | "high";
}

interface MessageWaiter<Message, Result> {
  message: Message;
  resolve(result: Result): void;
  reject(error: unknown): void;
}

interface ScheduledTask {
  run(): Promise<void>;
  cancel(error: Error): void;
}

interface ScopeState<Message, Result> {
  pendingMessages: MessageWaiter<Message, Result>[];
  debounceTimer?: ReturnType<typeof setTimeout>;
  queue: ScheduledTask[];
  draining?: Promise<void>;
}

export class FeishuScopeScheduler<Message, Result> {
  private readonly debounceMs: number;
  private readonly onMessageBatch: (
    scopeKey: string,
    messages: Message[],
  ) => Promise<Result>;
  private readonly scopes = new Map<string, ScopeState<Message, Result>>();
  private shuttingDown = false;

  constructor(options: FeishuScopeSchedulerOptions<Message, Result>) {
    this.debounceMs = options.debounceMs ?? 300;
    this.onMessageBatch = options.onMessageBatch;
  }

  enqueueMessage(scopeKey: string, message: Message): Promise<Result> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Feishu scope scheduler is shut down"));
    }
    const state = this.getOrCreateScope(scopeKey);
    const result = new Promise<Result>((resolve, reject) => {
      state.pendingMessages.push({ message, resolve, reject });
    });
    if (!state.debounceTimer) {
      state.debounceTimer = setTimeout(() => {
        state.debounceTimer = undefined;
        this.flushMessages(scopeKey, state);
      }, this.debounceMs);
      state.debounceTimer.unref?.();
    }
    return result;
  }

  enqueueControl<T>(
    scopeKey: string,
    operation: () => Promise<T>,
    options: FeishuControlOptions = {},
  ): Promise<T> {
    if (this.shuttingDown) {
      return Promise.reject(new Error("Feishu scope scheduler is shut down"));
    }
    const state = this.getOrCreateScope(scopeKey);
    const result = new Promise<T>((resolve, reject) => {
      const task: ScheduledTask = {
        run: async () => {
          try {
            resolve(await operation());
          } catch (error) {
            reject(error);
          }
        },
        cancel: reject,
      };
      if (options.priority === "high") state.queue.unshift(task);
      else state.queue.push(task);
    });
    this.startDrain(scopeKey, state);
    return result;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const error = new Error("Feishu scope scheduler is shut down");
    const running: Promise<void>[] = [];
    for (const state of this.scopes.values()) {
      if (state.debounceTimer) clearTimeout(state.debounceTimer);
      state.debounceTimer = undefined;
      for (const waiter of state.pendingMessages.splice(0)) {
        waiter.reject(error);
      }
      for (const task of state.queue.splice(0)) task.cancel(error);
      if (state.draining) running.push(state.draining);
    }
    await Promise.allSettled(running);
    this.scopes.clear();
  }

  get activeScopeCount(): number {
    return this.scopes.size;
  }

  private getOrCreateScope(scopeKey: string): ScopeState<Message, Result> {
    const existing = this.scopes.get(scopeKey);
    if (existing) return existing;
    const state: ScopeState<Message, Result> = {
      pendingMessages: [],
      queue: [],
    };
    this.scopes.set(scopeKey, state);
    return state;
  }

  private flushMessages(
    scopeKey: string,
    state: ScopeState<Message, Result>,
  ): void {
    const waiters = state.pendingMessages.splice(0);
    if (waiters.length === 0) {
      this.cleanupScope(scopeKey, state);
      return;
    }
    state.queue.push({
      run: async () => {
        try {
          const result = await this.onMessageBatch(
            scopeKey,
            waiters.map((waiter) => waiter.message),
          );
          for (const waiter of waiters) waiter.resolve(result);
        } catch (error) {
          for (const waiter of waiters) waiter.reject(error);
        }
      },
      cancel: (error) => {
        for (const waiter of waiters) waiter.reject(error);
      },
    });
    this.startDrain(scopeKey, state);
  }

  private startDrain(
    scopeKey: string,
    state: ScopeState<Message, Result>,
  ): void {
    if (state.draining) return;
    state.draining = this.drain(state).finally(() => {
      state.draining = undefined;
      if (state.queue.length > 0 && !this.shuttingDown) {
        this.startDrain(scopeKey, state);
      } else {
        this.cleanupScope(scopeKey, state);
      }
    });
  }

  private async drain(state: ScopeState<Message, Result>): Promise<void> {
    while (!this.shuttingDown) {
      const task = state.queue.shift();
      if (!task) return;
      await task.run();
    }
  }

  private cleanupScope(
    scopeKey: string,
    state: ScopeState<Message, Result>,
  ): void {
    if (
      !state.draining &&
      !state.debounceTimer &&
      state.pendingMessages.length === 0 &&
      state.queue.length === 0
    ) {
      this.scopes.delete(scopeKey);
    }
  }
}
