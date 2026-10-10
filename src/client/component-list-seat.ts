/** The id of the Starter's grouping row in its `cordis.patch.yml`. */
export const STARTER_GROUP_ROW_ID = 'mnemon-bundle'

/**
 * Whether DSH's component list on the dsh-mnemon page shows the Starter's
 * grouping row, which it shows as off. DSH 0.2.0 and earlier list it; DSH
 * 0.2.1 lists only the components. The page's head controls see the rows DSH
 * draws and report them here for the configuration above the list.
 */
export class MnemonComponentListSeat {
  private latest: { groupRow: boolean } | undefined
  private readonly listeners = new Set<() => void>()

  /** Undefined until a page reports, so nothing is said about a list not yet seen. */
  readonly getSnapshot = (): boolean | undefined => this.latest?.groupRow

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Report whether the open page lists the row until the returned disposer runs; a newer report replaces it. */
  report(groupRow: boolean): () => void {
    const report = { groupRow }
    this.latest = report
    this.emit()
    return () => {
      if (this.latest !== report) return
      this.latest = undefined
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
