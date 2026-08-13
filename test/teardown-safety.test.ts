import { describe, expect, it, vi } from "vitest";
import { BaichuanLogger } from "../src/baichuan-base";

/**
 * Two field failures, one root shape: something on a teardown path throws, and
 * because the caller is an async handler nobody awaits, the rest of the
 * cleanup silently never runs.
 *
 * - #8: `isDebugEnabled()` reads device storage. After Scrypted releases the
 *   device that access throws, and the first statement of `closeListener` is a
 *   `logger.debug(...)` — so the session was never released. 227 aborted
 *   closes in the reporter's logs.
 * - #9: the cached connect promise never settles, pinning every later caller
 *   behind it until Scrypted itself restarts.
 */

function makeLogger(isDebugEnabled: () => boolean) {
  const base = {
    log: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
  };
  return {
    logger: new BaichuanLogger(base as never, "test", isDebugEnabled),
    base,
  };
}

describe("BaichuanLogger.debug (issue #8)", () => {
  it("does not throw when the debug-enabled check throws", () => {
    // Exactly what a released device does: reading `.values` on an undefined
    // `storageSettings`.
    const { logger } = makeLogger(() => {
      throw new TypeError("Cannot read properties of undefined (reading 'storage')");
    });
    expect(() => logger.debug("teardown message")).not.toThrow();
  });

  it("stays silent rather than logging when the check throws", () => {
    const { logger, base } = makeLogger(() => {
      throw new Error("device released");
    });
    logger.debug("nope");
    expect(base.debug).not.toHaveBeenCalled();
  });

  it("still logs normally when debug is on", () => {
    const { logger, base } = makeLogger(() => true);
    logger.debug("hello");
    expect(base.debug).toHaveBeenCalledOnce();
  });

  it("stays silent when debug is off", () => {
    const { logger, base } = makeLogger(() => false);
    logger.debug("hello");
    expect(base.debug).not.toHaveBeenCalled();
  });

  it("survives a base logger that itself throws", () => {
    const base = {
      log: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      info: vi.fn(),
      debug: vi.fn(() => {
        throw new Error("console gone");
      }),
    };
    const logger = new BaichuanLogger(base as never, "test", () => true);
    expect(() => logger.debug("boom")).not.toThrow();
  });

  it("lets an async teardown handler finish after a failing debug call", async () => {
    // The regression in one shape: closeListener is async and its first
    // statement logs. If that throws, everything after it is skipped.
    const { logger } = makeLogger(() => {
      throw new Error("device released");
    });
    const released: string[] = [];

    const closeListener = async () => {
      logger.debug("Close event for stale client, ignoring");
      released.push("offSimpleEvent");
      released.push("onBeforeCleanup");
      released.push("session");
    };

    await expect(closeListener()).resolves.toBeUndefined();
    expect(released).toEqual(["offSimpleEvent", "onBeforeCleanup", "session"]);
  });
});

describe("bounded connect promise (issue #9)", () => {
  const TIMEOUT_MS = 45_000;

  /** Mirrors the race the plugin now wraps around its connect body. */
  function bounded<T>(inner: Promise<T>): { raced: Promise<T>; cancel: () => void } {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const raced = Promise.race([
      inner,
      new Promise<never>((_, reject) => {
        handle = setTimeout(
          () => reject(new Error(`ensureBaichuanClient timed out after ${TIMEOUT_MS}ms`)),
          TIMEOUT_MS,
        );
      }),
    ]);
    return { raced, cancel: () => handle && clearTimeout(handle) };
  }

  it("rejects a connect that never settles instead of pinning it forever", async () => {
    vi.useFakeTimers();
    try {
      const neverSettles = new Promise<string>(() => {});
      const { raced } = bounded(neverSettles);
      const assertion = expect(raced).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the cached promise so the next caller gets a fresh attempt", async () => {
    vi.useFakeTimers();
    try {
      let cached: Promise<string> | undefined;
      const attempt = async (inner: Promise<string>) => {
        const { raced, cancel } = bounded(inner);
        cached = raced;
        try {
          return await raced;
        } finally {
          cancel();
          cached = undefined;
        }
      };

      const hung = attempt(new Promise<string>(() => {}));
      const caught = hung.catch(() => "failed");
      await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 1);
      expect(await caught).toBe("failed");
      // The pin is gone — this is what made the camera unrecoverable.
      expect(cached).toBeUndefined();

      await expect(attempt(Promise.resolve("connected"))).resolves.toBe("connected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("passes a fast connection straight through", async () => {
    const { raced, cancel } = bounded(Promise.resolve("api"));
    await expect(raced).resolves.toBe("api");
    cancel();
  });
});
