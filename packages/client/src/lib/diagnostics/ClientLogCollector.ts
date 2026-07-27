import { fetchJSON } from "../../api/client";
import { connectionManager } from "../connection";
import { generateUUID } from "../uuid";
import {
  countEntries,
  deleteEntries,
  getAllEntries,
  openDatabase,
  putEntry,
} from "./idb";

export interface LogEntry {
  id?: number;
  timestamp: number;
  level: string;
  prefix: string;
  message: string;
}

const DB_NAME = "yep-anywhere-client-logs";
const DB_VERSION = 1;
const STORE_NAME = "entries";
const MAX_ENTRIES = 2000;
const FLUSH_BATCH_SIZE = 500;

const PREFIX_REGEX = /^\[([A-Za-z]+)\]/;
const DEVICE_ID_KEY = "yep-anywhere-device-id";

function getDeviceId(): string | undefined {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = generateUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    return undefined;
  }
}

export class ClientLogCollector {
  private _db: IDBDatabase | null = null;
  private _memoryBuffer: LogEntry[] = [];
  private _useMemoryFallback = false;
  private _started = false;
  private _flushing = false;
  private _deviceId: string | undefined;
  private _flushInterval: ReturnType<typeof setInterval> | null = null;
  private _lifecycleGeneration = 0;

  private _origLog: typeof console.log | null = null;
  private _origWarn: typeof console.warn | null = null;
  private _origError: typeof console.error | null = null;
  private _unsubscribeState: (() => void) | null = null;
  private _errorHandler: ((e: ErrorEvent) => void) | null = null;
  private _rejectionHandler: ((e: PromiseRejectionEvent) => void) | null = null;

  async start(): Promise<void> {
    if (this._started) return;
    this._started = true;
    const generation = ++this._lifecycleGeneration;
    this._deviceId = getDeviceId();

    let database: IDBDatabase | null = null;
    let useMemoryFallback = false;
    try {
      database = await openDatabase(DB_NAME, DB_VERSION, (db) => {
        db.createObjectStore(STORE_NAME, {
          keyPath: "id",
          autoIncrement: true,
        });
      });
    } catch {
      useMemoryFallback = true;
    }

    // stop() (or a newer stop/start cycle) may have happened while IndexedDB
    // was opening. Do not install console wrappers, listeners, or intervals for
    // an obsolete start attempt.
    if (!this._started || generation !== this._lifecycleGeneration) {
      database?.close();
      return;
    }

    this._db = database;
    this._useMemoryFallback = useMemoryFallback;
    this._wrapConsole();
    this._writeEntry(
      "info",
      "[ClientInfo]",
      `[ClientInfo] ${navigator.userAgent} | ${window.screen.width}x${window.screen.height} | dpr=${window.devicePixelRatio} | lang=${navigator.language}`,
    );

    this._unsubscribeState = connectionManager.on("stateChange", (state) => {
      if (state === "connected") {
        this.flush();
      }
    });

    // Flush immediately if already connected (e.g. setting enabled mid-session)
    if (connectionManager.state === "connected") {
      this.flush();
    }

    // Periodic flush so logs don't sit indefinitely in IDB between connection
    // state changes. Without this, only the initial ClientInfo banner makes
    // it to the server when the toggle is enabled mid-session — every
    // subsequent log is stranded on-device until the next reconnect.
    this._flushInterval = setInterval(() => {
      if (connectionManager.state === "connected") {
        this.flush();
      }
    }, 3000);
  }

  stop(): void {
    if (!this._started) return;
    this._started = false;
    this._lifecycleGeneration += 1;

    if (this._flushInterval !== null) {
      clearInterval(this._flushInterval);
      this._flushInterval = null;
    }

    this._restoreConsole();

    if (this._unsubscribeState) {
      this._unsubscribeState();
      this._unsubscribeState = null;
    }

    if (this._db) {
      this._db.close();
      this._db = null;
    }

    this._memoryBuffer = [];
    this._useMemoryFallback = false;
  }

  async flush(): Promise<void> {
    if (this._flushing) return;
    this._flushing = true;
    try {
      await this._doFlush();
    } finally {
      this._flushing = false;
    }
  }

  private async _doFlush(): Promise<void> {
    let entries: LogEntry[];

    if (this._useMemoryFallback || !this._db) {
      entries = this._memoryBuffer.splice(0, FLUSH_BATCH_SIZE);
      if (entries.length === 0) return;
    } else {
      entries = await getAllEntries<LogEntry>(
        this._db,
        STORE_NAME,
        FLUSH_BATCH_SIZE,
      );
      if (entries.length === 0) return;
    }

    try {
      await fetchJSON("/client-logs", {
        method: "POST",
        body: JSON.stringify({
          entries,
          deviceId: this._deviceId,
        }),
      });

      // Delete flushed entries from IDB
      if (!this._useMemoryFallback && this._db) {
        const keys = entries
          .map((e) => e.id)
          .filter((id): id is number => id != null);
        if (keys.length > 0) {
          await deleteEntries(this._db, STORE_NAME, keys);
        }
      }
    } catch {
      // If flush fails (e.g. not connected), put memory entries back
      if (this._useMemoryFallback) {
        this._memoryBuffer.unshift(...entries);
      }
    }
  }

  private _writeEntry(level: string, prefix: string, message: string): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      prefix,
      message,
    };

    if (this._useMemoryFallback || !this._db) {
      this._memoryBuffer.push(entry);
      if (this._memoryBuffer.length > MAX_ENTRIES) {
        this._memoryBuffer = this._memoryBuffer.slice(-MAX_ENTRIES);
      }
      return;
    }

    putEntry(this._db, STORE_NAME, entry).then(() => {
      this._trimEntries();
    });
  }

  private async _trimEntries(): Promise<void> {
    if (!this._db) return;
    const count = await countEntries(this._db, STORE_NAME);
    if (count <= MAX_ENTRIES) return;

    // Get the oldest entries to delete
    const excess = count - MAX_ENTRIES;
    const oldest = await getAllEntries<LogEntry>(this._db, STORE_NAME, excess);
    const keys = oldest
      .map((e) => e.id)
      .filter((id): id is number => id != null);
    if (keys.length > 0) {
      await deleteEntries(this._db, STORE_NAME, keys);
    }
  }

  private _wrapConsole(): void {
    this._origLog = console.log;
    this._origWarn = console.warn;
    this._origError = console.error;

    console.log = (...args: unknown[]) => {
      this._capture("log", args);
      this._origLog?.apply(console, args);
    };
    console.warn = (...args: unknown[]) => {
      this._capture("warn", args);
      this._origWarn?.apply(console, args);
    };
    console.error = (...args: unknown[]) => {
      this._capture("error", args);
      this._origError?.apply(console, args);
    };

    // Capture unhandled exceptions and promise rejections
    this._errorHandler = (e: ErrorEvent) => {
      const msg =
        e.error instanceof Error
          ? (e.error.stack ?? e.error.message)
          : e.message;
      this._writeEntry("error", "[UncaughtError]", msg);
    };
    this._rejectionHandler = (e: PromiseRejectionEvent) => {
      const reason =
        e.reason instanceof Error
          ? (e.reason.stack ?? e.reason.message)
          : String(e.reason);
      this._writeEntry("error", "[UnhandledRejection]", reason);
    };
    window.addEventListener("error", this._errorHandler);
    window.addEventListener("unhandledrejection", this._rejectionHandler);
  }

  private _restoreConsole(): void {
    if (this._origLog) console.log = this._origLog;
    if (this._origWarn) console.warn = this._origWarn;
    if (this._origError) console.error = this._origError;
    this._origLog = null;
    this._origWarn = null;
    this._origError = null;

    if (this._errorHandler) {
      window.removeEventListener("error", this._errorHandler);
      this._errorHandler = null;
    }
    if (this._rejectionHandler) {
      window.removeEventListener("unhandledrejection", this._rejectionHandler);
      this._rejectionHandler = null;
    }
  }

  /** Capture all warn/error messages unconditionally */
  private _capture(level: string, args: unknown[]): void {
    if (args.length === 0) return;
    const message = args
      .map((a) =>
        typeof a === "string"
          ? a
          : a instanceof Error
            ? `${a.message}${a.stack ? `\n${a.stack}` : ""}`
            : JSON.stringify(a),
      )
      .join(" ");

    const first = args[0];
    const prefix =
      typeof first === "string" ? (PREFIX_REGEX.exec(first)?.[0] ?? "") : "";
    this._writeEntry(level, prefix, message);
  }
}
