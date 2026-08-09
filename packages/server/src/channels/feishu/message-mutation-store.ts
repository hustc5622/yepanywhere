import { chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../utils/atomic-json-file.js";
import type {
  FeishuMessageMutation,
  FeishuMessageMutationKind,
} from "./message-mutation.js";

export interface FeishuPersistedMessageMutation extends FeishuMessageMutation {
  accountId: string;
  persistedAt: string;
}

export interface FeishuMessageReactionState {
  key: string;
  emojiType: string;
  actorId?: string;
  updatedAtMs: number;
}

export interface FeishuMessageMutationState {
  version: 1;
  accountId: string;
  messageId: string;
  revision: number;
  editedAtMs?: number;
  recalledAtMs?: number;
  recallType?: string;
  reactions: FeishuMessageReactionState[];
  anomalies: string[];
  lastMutationKind: FeishuMessageMutationKind;
  lastEventAtMs: number;
}

export interface FeishuMessageMutationStoreOptions {
  dataDir: string;
  maxEvents?: number;
  maxStates?: number;
}

export interface FeishuMessageMutationApplyResult {
  applied: boolean;
  state: FeishuMessageMutationState;
}

const ActorSchema = z.object({
  id: z.string().min(1).max(512).optional(),
  type: z.string().min(1).max(128).optional(),
});

const ReactionSchema = z.object({
  key: z.string().regex(/^[a-f0-9]{64}$/u),
  emojiType: z.string().min(1).max(128),
});

const PersistedMutationSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1).max(64),
  eventId: z.string().min(1).max(512),
  eventType: z.string().min(1).max(128),
  messageId: z.string().min(1).max(512),
  kind: z.enum(["edited", "recalled", "reaction_added", "reaction_removed"]),
  occurredAtMs: z.number().int().nonnegative().safe(),
  source: z.enum(["event", "message_read_observation"]),
  actor: ActorSchema.optional(),
  reaction: ReactionSchema.optional(),
  recallType: z.string().min(1).max(128).optional(),
  persistedAt: z.iso.datetime(),
});

const ReactionStateSchema = ReactionSchema.extend({
  actorId: z.string().min(1).max(512).optional(),
  updatedAtMs: z.number().int().nonnegative().safe(),
});

const MutationStateSchema = z.object({
  version: z.literal(1),
  accountId: z.string().min(1).max(64),
  messageId: z.string().min(1).max(512),
  revision: z.number().int().positive().safe(),
  editedAtMs: z.number().int().nonnegative().safe().optional(),
  recalledAtMs: z.number().int().nonnegative().safe().optional(),
  recallType: z.string().min(1).max(128).optional(),
  reactions: z.array(ReactionStateSchema).max(512),
  anomalies: z.array(z.string().min(1).max(128)).max(32),
  lastMutationKind: z.enum([
    "edited",
    "recalled",
    "reaction_added",
    "reaction_removed",
  ]),
  lastEventAtMs: z.number().int().nonnegative().safe(),
});

const StoreDocumentSchema = z.object({
  version: z.literal(1),
  events: z.array(PersistedMutationSchema),
  states: z.array(MutationStateSchema),
});

const DEFAULT_MAX_EVENTS = 10_000;
const DEFAULT_MAX_STATES = 10_000;

export class FeishuMessageMutationStore {
  readonly filePath: string;
  private readonly maxEvents: number;
  private readonly maxStates: number;
  private events: FeishuPersistedMessageMutation[] = [];
  private readonly states = new Map<string, FeishuMessageMutationState>();
  private readonly eventKeys = new Set<string>();
  private operationChain: Promise<void> = Promise.resolve();
  private initialized = false;

  constructor(options: FeishuMessageMutationStoreOptions) {
    this.filePath = join(
      options.dataDir,
      "channels",
      "feishu",
      "message-mutations.json",
    );
    this.maxEvents = normalizeLimit(options.maxEvents, DEFAULT_MAX_EVENTS);
    this.maxStates = normalizeLimit(options.maxStates, DEFAULT_MAX_STATES);
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    let parsed: z.infer<typeof StoreDocumentSchema>;
    try {
      parsed = StoreDocumentSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      parsed = { version: 1, events: [], states: [] };
      await atomicWriteJson(this.filePath, parsed);
    }
    if (process.platform !== "win32") {
      await chmod(this.filePath, 0o600);
    }
    this.events = parsed.events as FeishuPersistedMessageMutation[];
    this.states.clear();
    this.eventKeys.clear();
    for (const state of parsed.states) {
      this.states.set(
        stateKey(state.accountId, state.messageId),
        state as FeishuMessageMutationState,
      );
    }
    for (const event of this.events) {
      this.eventKeys.add(eventKey(event.accountId, event.eventId));
    }
    this.initialized = true;
  }

  isOperational(): boolean {
    return this.initialized;
  }

  apply(
    accountId: string,
    mutation: FeishuMessageMutation,
    now = new Date(),
  ): Promise<FeishuMessageMutationApplyResult> {
    this.assertInitialized();
    return this.enqueue(async () => {
      const persisted = PersistedMutationSchema.parse({
        ...mutation,
        accountId,
        persistedAt: now.toISOString(),
      }) as FeishuPersistedMessageMutation;
      const dedupeKey = eventKey(accountId, persisted.eventId);
      const current = this.states.get(stateKey(accountId, mutation.messageId));
      if (this.eventKeys.has(dedupeKey)) {
        if (!current) {
          throw new Error("Feishu mutation dedupe state is missing");
        }
        return { applied: false, state: structuredClone(current) };
      }

      const nextState = reduceMutation(current, persisted);
      const nextEvents = [...this.events, persisted].slice(-this.maxEvents);
      const nextStates = new Map(this.states);
      nextStates.delete(stateKey(accountId, mutation.messageId));
      nextStates.set(stateKey(accountId, mutation.messageId), nextState);
      while (nextStates.size > this.maxStates) {
        const oldest = [...nextStates.entries()].sort(
          ([, left], [, right]) => left.lastEventAtMs - right.lastEventAtMs,
        )[0]?.[0];
        if (!oldest) break;
        nextStates.delete(oldest);
      }
      await atomicWriteJson(this.filePath, {
        version: 1,
        events: nextEvents,
        states: [...nextStates.values()],
      });

      this.events = nextEvents;
      this.states.clear();
      for (const [key, value] of nextStates) this.states.set(key, value);
      this.eventKeys.clear();
      for (const event of nextEvents) {
        this.eventKeys.add(eventKey(event.accountId, event.eventId));
      }
      return { applied: true, state: structuredClone(nextState) };
    });
  }

  getState(
    accountId: string,
    messageId: string,
  ): FeishuMessageMutationState | undefined {
    this.assertInitialized();
    const state = this.states.get(stateKey(accountId, messageId));
    return state ? structuredClone(state) : undefined;
  }

  listEvents(accountId?: string): FeishuPersistedMessageMutation[] {
    this.assertInitialized();
    return this.events
      .filter(
        (event) => accountId === undefined || event.accountId === accountId,
      )
      .map((event) => structuredClone(event));
  }

  private assertInitialized(): void {
    if (!this.initialized) {
      throw new Error("FeishuMessageMutationStore is not initialized");
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationChain.then(operation);
    this.operationChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function reduceMutation(
  current: FeishuMessageMutationState | undefined,
  mutation: FeishuPersistedMessageMutation,
): FeishuMessageMutationState {
  const anomalies = [...(current?.anomalies ?? [])];
  if (current?.recalledAtMs !== undefined && mutation.kind !== "recalled") {
    addAnomaly(anomalies, "MUTATION_AFTER_RECALL");
  }
  const reactions = new Map(
    (current?.reactions ?? []).map((reaction) => [reaction.key, reaction]),
  );
  if (mutation.kind === "reaction_added" && mutation.reaction) {
    reactions.set(mutation.reaction.key, {
      ...mutation.reaction,
      ...(mutation.actor?.id ? { actorId: mutation.actor.id } : {}),
      updatedAtMs: mutation.occurredAtMs,
    });
  } else if (mutation.kind === "reaction_removed" && mutation.reaction) {
    if (!reactions.delete(mutation.reaction.key)) {
      addAnomaly(anomalies, "REACTION_REMOVE_WITHOUT_ADD");
    }
  }
  if (
    mutation.kind === "edited" &&
    current?.editedAtMs !== undefined &&
    mutation.occurredAtMs < current.editedAtMs
  ) {
    addAnomaly(anomalies, "OUT_OF_ORDER_EDIT");
  }
  return MutationStateSchema.parse({
    version: 1,
    accountId: mutation.accountId,
    messageId: mutation.messageId,
    revision: (current?.revision ?? 0) + 1,
    editedAtMs:
      mutation.kind === "edited"
        ? Math.max(current?.editedAtMs ?? 0, mutation.occurredAtMs)
        : current?.editedAtMs,
    recalledAtMs:
      mutation.kind === "recalled"
        ? Math.max(current?.recalledAtMs ?? 0, mutation.occurredAtMs)
        : current?.recalledAtMs,
    recallType:
      mutation.kind === "recalled" ? mutation.recallType : current?.recallType,
    reactions: [...reactions.values()].sort((left, right) =>
      left.key.localeCompare(right.key),
    ),
    anomalies: anomalies.slice(-32),
    lastMutationKind: mutation.kind,
    lastEventAtMs: Math.max(current?.lastEventAtMs ?? 0, mutation.occurredAtMs),
  }) as FeishuMessageMutationState;
}

function addAnomaly(anomalies: string[], anomaly: string): void {
  if (!anomalies.includes(anomaly)) anomalies.push(anomaly);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && (value ?? 0) > 0
    ? (value as number)
    : fallback;
}

function eventKey(accountId: string, eventId: string): string {
  return `${accountId}\0${eventId}`;
}

function stateKey(accountId: string, messageId: string): string {
  return `${accountId}\0${messageId}`;
}

function isMissingFile(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
