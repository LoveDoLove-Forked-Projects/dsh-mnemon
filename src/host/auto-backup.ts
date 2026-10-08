import type { MnemonSyncAutoBackup } from './protocol.ts'
import type { LiveMnemonRuntime } from './runtime.ts'

/** The one failure that is not worth reporting: the reader is already working. */
const BUSY_MESSAGE = 'another Mnemon sync operation is still running'

/** One minute, the unit the settings form counts in. */
const MINUTE_MS = 60_000

/**
 * The background half of the Git channel: one timer for the whole Host that
 * repeats the exact push the button runs, at the interval the sync settings
 * hold.
 *
 * Three rules shape it:
 *
 * - It lives beside the runtime, never inside one. A settings write builds a
 *   throwaway graph to validate itself, and a timer owned by a graph would be
 *   created and destroyed on every keystroke in the settings form.
 * - It reads the interval from the settings file on every tick, so a change
 *   saved through the settings page takes effect without restarting anything.
 * - It writes nothing a human did not already agree to: the push it runs is the
 *   same confirmed push the button runs, and the merge inside that push is the
 *   only thing that ever brings remote entries into this machine.
 */
export class MnemonAutoBackupScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined
  private controller: AbortController | undefined
  private running = false
  private stopped = false
  private lastAt: string | undefined
  private lastAttemptAt: number | undefined
  private lastError: string | undefined
  private lastCommit: string | undefined
  private lastPushed: boolean | undefined

  constructor(
    private readonly runtime: LiveMnemonRuntime,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Arm the timer and hand back the stop closure the plugin effect returns. */
  start(): () => void {
    this.schedule()
    return () => {
      this.stopped = true
      this.cancel()
    }
  }

  /**
   * Re-read the interval and re-arm without running anything. The settings page
   * calls this after a save so a shortened interval starts counting from now
   * instead of from whenever the previous timer happened to be armed.
   */
  refresh(): void {
    if (this.stopped) return
    this.cancel()
    this.schedule()
  }

  /** What the settings page shows about the background cadence. */
  snapshot(): MnemonSyncAutoBackup {
    const minutes = this.minutes()
    const available = minutes > 0 && !this.stopped
    return {
      available,
      ...(this.lastAt === undefined ? {} : { lastAt: this.lastAt }),
      // The Host reports when the next run is due only while one is armed, so a
      // stopped timer never advertises a time it will not keep.
      ...(this.lastAttemptAt === undefined || !available ? {} : { nextAt: new Date(this.lastAttemptAt + minutes * MINUTE_MS).toISOString() }),
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
      ...(this.lastCommit === undefined ? {} : { lastCommit: this.lastCommit }),
      ...(this.lastPushed === undefined ? {} : { lastPushed: this.lastPushed }),
    }
  }

  /**
   * The saved interval, or zero when it cannot be read at all. A configuration
   * file a human edited by hand can fail to parse, and a timer is the last
   * place that should turn that into an exception nobody sees.
   */
  private minutes(): number {
    try {
      return this.runtime.sync.settings().read().autoBackupMinutes
    } catch {
      return 0
    }
  }

  private schedule(): void {
    if (this.stopped || this.timer !== undefined) return
    const minutes = this.minutes()
    if (minutes <= 0) return
    this.lastAttemptAt = this.now().getTime()
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.run()
    }, minutes * MINUTE_MS)
  }

  private cancel(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    this.controller?.abort()
    this.controller = undefined
  }

  private async run(): Promise<void> {
    if (this.stopped || this.running) return this.schedule()
    const sync = this.runtime.sync
    this.running = true
    const controller = new AbortController()
    this.controller = controller
    try {
      const settings = sync.settings().read()
      if (settings.repoUrl === undefined) {
        // Nothing to publish to yet. The timer keeps running, so configuring a
        // repository later needs no second visit to the settings page.
        this.lastError = undefined
      } else if (!this.runtime.config.writeEnabled) {
        // A Host that cannot write says so, and the message matches what the RPC
        // layer refuses with, so the page never shows two names for one fact.
        this.lastError = 'dsh-mnemon is configured read-only'
      } else {
        const result = await sync.push({ signal: controller.signal })
        this.lastAt = this.now().toISOString()
        this.lastCommit = result.commit
        this.lastPushed = result.pushed
        // A payload the branch already holds is not a failure, so the reason is
        // only kept when a commit that should have travelled did not.
        this.lastError = result.pushed ? undefined : result.committed ? result.reason : undefined
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!this.stopped && !message.includes(BUSY_MESSAGE)) {
        this.lastError = message
        console.warn('dsh-mnemon: automatic Git backup failed', error)
      }
    } finally {
      this.running = false
      if (this.controller === controller) this.controller = undefined
      this.schedule()
    }
  }
}
