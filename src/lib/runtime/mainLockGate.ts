/** Fail closed when the main worker lease cannot be proven. */
export async function mainLockGranted(acquire: () => Promise<boolean>): Promise<boolean> {
  try {
    return (await acquire()) === true;
  } catch {
    return false;
  }
}

/**
 * Keep the already-acquired main lease alive during a long tick.
 * A failed renewal revokes authority for the rest of the tick; it must not
 * silently re-acquire after another worker may have taken over.
 *
 * This guards the start of subsequent main-only tasks. In-flight network
 * operations still need their own atomic claim/fencing at the target.
 */
export class MainLeaseKeeper {
  private active = true;
  private timer: ReturnType<typeof setInterval> | null = null;
  private pending: Promise<boolean> | null = null;
  private checkedAt: number;

  constructor(
    private readonly renew: () => Promise<boolean>,
    private readonly everyMs: number,
    private readonly onLost: () => void = () => {},
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(everyMs) || everyMs <= 0) throw new Error('Invalid main lease renewal interval');
    this.checkedAt = now(); // initial lease was already acquired by the caller
  }

  start(): void {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => { void this.refresh(); }, this.everyMs);
  }

  /** A lost lease never silently re-acquires main authority within this tick. */
  async allowed(): Promise<boolean> {
    if (!this.active) return false;
    if (this.pending) return this.pending;
    if (this.now() - this.checkedAt < this.everyMs) return true;
    return this.refresh();
  }

  /** Only an explicit true proves renewal. Errors, nulls and false revoke authority. */
  refresh(): Promise<boolean> {
    if (!this.active) return Promise.resolve(false);
    if (this.pending) return this.pending;
    // acquireLock computes expires_at before its DB round trip. A slow ACK is stale.
    const startedAt = this.now();
    const attempt = Promise.resolve().then(this.renew).then(
      (ok) => {
        if (!this.active) return false;
        if (ok !== true || this.now() - startedAt >= this.everyMs) { this.lose(); return false; }
        this.checkedAt = startedAt;
        return true;
      },
      () => { this.lose(); return false; },
    );
    this.pending = attempt;
    void attempt.then(() => { if (this.pending === attempt) this.pending = null; });
    return attempt;
  }

  stop(): void {
    this.active = false;
    this.stopTimer();
  }

  private lose(): void {
    if (!this.active) return;
    this.active = false;
    this.stopTimer();
    try { this.onLost(); } catch { /* logging cannot re-grant authority */ }
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
