import { currentOS, onAppBackground } from "./lifecycle.js";
import { DurableQueue } from "./queue.js";
import { LIB_VERSION, nowISO, Session, uuid } from "./runtime.js";
import { MemoryStorage, SafeStorage } from "./storage.js";
import { Transport, type SendResult } from "./transport.js";
import type {
  IdentifyParams,
  QueuedOp,
  TrackOp,
  WhisperrApi,
  WhisperrChannel,
  WhisperrError,
  WhisperrOptions,
} from "./types.js";

const DEFAULT_BASE = "https://api.whisperr.net";
const SNAKE_CASE = /^[a-z0-9]+(?:_[a-z0-9]+)*$/;

const ANON_KEY = "whisperr.anon_id";
const USER_KEY = "whisperr.user_id";
const OPTOUT_KEY = "whisperr.optout";

export class WhisperrClient implements WhisperrApi {
  private readonly storage: SafeStorage;
  private readonly queue: DurableQueue;
  private readonly transport: Transport;
  private readonly session: Session;

  private readonly flushAt: number;
  private readonly maxBatchSize: number;
  private readonly maxRetries: number;
  private readonly debug: boolean;
  private readonly onError?: (error: WhisperrError) => void;

  private userId: string | null = null;
  private anonId = "";
  private muted: boolean; // opted out / disabled — capture is a no-op
  private closed = false;
  /** identify()/reset() ran before init resolved — don't adopt the persisted user. */
  private identityTouched = false;
  private drainChain: Promise<void> = Promise.resolve();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private removeLifecycle: () => void = () => {};
  private readonly initPromise: Promise<void>;

  constructor(options: WhisperrOptions) {
    const baseUrl = (options.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.flushAt = options.flushAt ?? 20;
    this.maxBatchSize = Math.min(options.maxBatchSize ?? 500, 500);
    this.maxRetries = options.maxRetries ?? 6;
    this.debug = options.debug ?? false;
    this.onError = options.onError;
    this.muted = !!options.disabled;

    if (!options.storage) {
      this.log("no `storage` provided — the queue is memory-only. Pass AsyncStorage to survive app restarts.");
    }
    this.storage = new SafeStorage(options.storage ?? new MemoryStorage());
    this.queue = new DurableQueue(this.storage, options.maxQueueSize ?? 1000);
    this.session = new Session(this.storage);
    this.transport = new Transport(baseUrl, options.apiKey, options.requestTimeoutMs ?? 10000, this.debug);

    this.initPromise = options.disabled ? Promise.resolve() : this.init();

    if (!options.disabled) {
      this.startTimer(options.flushIntervalMs ?? 10000);
      if (options.flushOnAppBackground ?? true) {
        this.removeLifecycle = onAppBackground(() => void this.flush());
      }
      // Drain anything left over from a previous launch.
      void this.initPromise.then(() => {
        if (!this.muted && !this.closed && this.queue.size > 0) void this.flush();
      });
    }
  }

  get ready(): boolean {
    return !this.muted && !this.closed;
  }

  get pendingCount(): number {
    return this.queue.size;
  }

  identify(externalUserId: string, params: IdentifyParams = {}): void {
    if (this.muted || this.closed || !externalUserId) return;
    this.identityTouched = true;
    this.userId = externalUserId;
    void this.storage.set(USER_KEY, externalUserId);

    this.enqueue({
      kind: "identify",
      externalUserId,
      traits: params.traits,
      preferredChannel: params.preferredChannel,
      channels: buildChannels(params),
      occurredAt: nowISO(),
    });
    // Anonymous → identified: attribute buffered pre-login events to this user.
    this.queue.backfillIdentity(externalUserId);
    void this.flush();
  }

  track(eventType: string, properties?: Record<string, unknown>, context?: Record<string, unknown>): void {
    if (this.muted || this.closed || !eventType) return;
    const type = eventType.trim();
    if (!type) return;
    if (!SNAKE_CASE.test(type)) {
      this.emit({ type: "dropped", message: `invalid event_type "${type}" — expected snake_case` });
      this.log(`invalid event_type "${type}" — event was not queued`);
      return;
    }
    this.enqueue({
      kind: "track",
      eventType: type,
      externalUserId: this.userId, // null until identify(); backfilled later
      properties,
      context: { ...this.baseContext(), ...context },
      occurredAt: nowISO(),
      messageId: uuid(),
    });
    if (this.sendableCount() >= this.flushAt) void this.flush();
  }

  screen(name?: string, properties?: Record<string, unknown>): void {
    // snake_case to satisfy the ingestion validator (it rejects "$"-prefixed types).
    this.track("screen_viewed", { name, ...properties });
  }

  reset(): void {
    if (this.closed) return;
    this.identityTouched = true;
    this.userId = null;
    this.anonId = `anon_${uuid()}`; // fresh anonymous identity
    void this.storage.remove(USER_KEY);
    void this.storage.set(ANON_KEY, this.anonId);
  }

  optIn(): void {
    if (this.closed) return;
    this.muted = false;
    void this.storage.remove(OPTOUT_KEY);
  }

  optOut(): void {
    this.muted = true;
    this.queue.clear();
    void this.storage.set(OPTOUT_KEY, "1");
  }

  async flush(): Promise<void> {
    if (this.muted || this.closed) return;
    // Serialize drains and guarantee that awaiting flush() waits for a drain
    // pass that runs AFTER this call — so `await whisperr.flush()` before logout
    // actually delivers everything queued, even if a background flush is mid-send.
    const next = this.drainChain.then(() => this.drain()).catch(() => {});
    this.drainChain = next;
    await next;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.flush();
    this.closed = true;
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.removeLifecycle();
    this.removeLifecycle = () => {};
    await this.queue.settle();
  }

  // ---- internals ----

  private async init(): Promise<void> {
    if (await this.storage.get(OPTOUT_KEY)) {
      this.muted = true;
      this.queue.clear(); // drop anything captured before the opt-out was read
      return;
    }

    const anon = await this.storage.get(ANON_KEY);
    if (this.anonId === "") {
      this.anonId = anon ?? `anon_${uuid()}`;
      if (!anon) void this.storage.set(ANON_KEY, this.anonId);
    }

    const user = await this.storage.get(USER_KEY);
    if (user && !this.identityTouched) this.userId = user;

    await this.session.restore();
    await this.queue.restore();
    // Ops captured before we knew who the user is (this launch or a previous
    // one that never identified) now attribute to the restored identity.
    if (this.userId) this.queue.backfillIdentity(this.userId);
  }

  private async drain(): Promise<void> {
    await this.initPromise;
    if (this.muted) return;

    let retries = 0;
    while (this.queue.size > 0) {
      const ops = this.queue.all;
      const front = ops[0]!;
      if (front.kind === "track" && front.externalUserId === null) break; // buffered pre-identify

      let result: SendResult;
      let count: number;
      if (front.kind === "identify") {
        result = await this.transport.sendIdentify(front);
        count = 1;
      } else {
        const batch = this.takeTrackBatch(ops);
        result = await this.transport.sendBatch(batch);
        count = batch.length;
      }

      if (result === "ok") {
        this.queue.removeFront(count);
        retries = 0;
        continue;
      }
      if (result === "drop") {
        this.queue.removeFront(count);
        retries = 0;
        this.emit({ type: "dropped", message: `dropped ${count} event(s) — rejected by server` });
        continue;
      }
      if (result === "auth") {
        this.emit({ type: "auth", message: "delivery paused — API key rejected", status: 401 });
        break; // keep queue for a later attempt
      }
      // retry
      if (++retries > this.maxRetries) {
        this.emit({ type: "retry_exhausted", message: "delivery failed after retries; will retry on next flush" });
        break;
      }
      await delay(backoff(retries));
    }
  }

  private enqueue(op: QueuedOp): void {
    const dropped = this.queue.enqueue(op);
    if (dropped > 0) {
      this.emit({ type: "dropped", message: `queue overflow — dropped ${dropped} oldest event(s)` });
    }
  }

  private takeTrackBatch(ops: readonly QueuedOp[]): TrackOp[] {
    const batch: TrackOp[] = [];
    for (const op of ops) {
      if (op.kind === "track" && op.externalUserId) {
        batch.push(op);
        if (batch.length >= this.maxBatchSize) break;
      } else {
        break;
      }
    }
    return batch;
  }

  private sendableCount(): number {
    let n = 0;
    for (const op of this.queue.all) {
      if (op.kind === "track" && op.externalUserId === null) break;
      n++;
    }
    return n;
  }

  private baseContext(): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      library: { name: "whisperr-react-native", version: LIB_VERSION },
      session_id: this.session.current(),
    };
    const os = currentOS();
    if (os) ctx.os = os;
    return ctx;
  }

  private startTimer(intervalMs: number): void {
    if (intervalMs <= 0) return;
    this.flushTimer = setInterval(() => void this.flush(), intervalMs);
    // Don't keep a Node-like host process alive (tests, RN debugging in Node).
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  private emit(error: WhisperrError): void {
    try {
      this.onError?.(error);
    } catch {
      /* host callback threw — ignore */
    }
  }

  private log(message: string): void {
    if (this.debug && typeof console !== "undefined") {
      // eslint-disable-next-line no-console
      console.warn(`[whisperr] ${message}`);
    }
  }
}

function buildChannels(params: IdentifyParams): WhisperrChannel[] | undefined {
  if (params.channels && params.channels.length) return params.channels;
  const out: WhisperrChannel[] = [];
  if (params.email) out.push({ type: "email", address: params.email, optedIn: true });
  if (params.phone) out.push({ type: "sms", address: params.phone, optedIn: true });
  if (params.pushToken) out.push({ type: "push", address: params.pushToken, optedIn: true });
  return out.length ? out : undefined;
}

function backoff(attempt: number): number {
  const base = Math.min(30000, 1000 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
