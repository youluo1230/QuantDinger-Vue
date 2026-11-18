<template>
  <div class="tv-chart" :class="`tv-chart--${theme}`">
    <div ref="chartHost" class="tv-chart__host" :class="{ 'tv-chart__host--active': hostSlot === 0 }" />
    <div ref="chartHostSpare" class="tv-chart__host" :class="{ 'tv-chart__host--active': hostSlot === 1 }" />
    <div class="tv-chart__tables" aria-hidden="true">
      <table
        v-for="(table, tableIndex) in indicatorTables"
        :key="tableIndex"
        class="tv-chart__table"
        :class="`tv-chart__table--${table.position.replace(/_/g, '-')}`"
        :style="tableStyle(table)"
      >
        <tbody>
          <tr v-for="row in tableRows(table)" :key="row.index">
            <td
              v-for="cell in row.cells"
              :key="cell.column"
              :style="cellStyle(cell)"
              :title="cell.tooltip || null"
            >{{ cell.text }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-if="error" class="tv-chart__error">{{ error }}</div>
    <div v-else-if="indicatorError" class="tv-chart__warning">{{ indicatorError }}</div>
  </div>
</template>

<script>
import { createBarStore, intervalFor, mountTradingViewChart } from '@/charting/tradingview'
import { createSeriesCache, createStudyBarCache, resolveCustomIndicators } from '@/charting/indicatorPlots'

/**
 * TradingView Charting Library surface.
 *
 * This is the only chart the Indicator IDE draws on. It owns no data of its own:
 * the datafeed in `charting/datafeed.js` answers every bar request from the
 * market-data API, and indicators are executed in this process by PineTS -- see
 * `indicatorPlots.js`. Nothing about a study travels over the network, which is
 * why a study can be redrawn as often as the author saves.
 */
/**
 * A short, stable fingerprint of a script's text.
 *
 * Only used to notice that code changed, so a cheap FNV-1a is enough: this runs
 * on every render for every study, and a cryptographic digest over a 2000-line
 * script is time the page does not have. Length is mixed in by the caller, which
 * covers the one weakness a short hash has against accidental collisions.
 */
/**
 * How often a live bar may trigger a study recalculation.
 *
 * The venue pushes several ticks a second and every one of them runs every
 * checked script again. A study is a line on a chart, not an order book, so
 * four updates a second is already faster than the eye: this is the gap
 * between passes, not a debounce, so a burst is coalesced into the next slot
 * instead of being dropped.
 */
const LIVE_RESOLVE_MS = 250

/** Pine's label sizes, as the library's text tool measures them. */
const LABEL_FONT_SIZE = { tiny: 9, small: 11, normal: 14, large: 18, huge: 24 }

/**
 * A Pine label as the library's text-drawing overrides.
 *
 * The library draws the text in `color` and fills the box with it when
 * `fillBackground` is set, which is the opposite of Pine -- there `color` is the
 * box and `textcolor` is the writing. So the two are swapped rather than passed
 * through, and a label the script left with no explicit colour keeps the
 * library's defaults instead of being painted black.
 */
function labelOverrides (label) {
  const overrides = {
    'linetooltext.fontsize': LABEL_FONT_SIZE[String(label.size || '').toLowerCase()] || LABEL_FONT_SIZE.normal,
    'linetooltext.wordWrap': true,
    'linetooltext.wordWrapWidth': 240,
    'linetooltext.fixedSize': false
  }
  if (label.textColor) overrides['linetooltext.color'] = label.textColor
  if (label.color) {
    overrides['linetooltext.fillBackground'] = true
    overrides['linetooltext.backgroundColor'] = label.color
    // Pine's box is opaque; without this the library paints it at 70% and a
    // dark label over a candle becomes unreadable.
    overrides['linetooltext.backgroundTransparency'] = 10
  }
  return overrides
}

function codeFingerprint (code) {
  const text = String(code || '')
  if (!text) return '0'
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(36)
}

export default {
  name: 'TradingViewChart',
  props: {
    market: { type: String, default: 'Crypto' },
    symbol: { type: String, required: true },
    exchangeId: { type: String, default: '' },
    marketType: { type: String, default: '' },
    instrumentId: { type: String, default: '' },
    timeframe: { type: String, default: '1H' },
    theme: { type: String, default: 'dark' },
    locale: { type: String, default: 'zh' },
    // Indicators to draw, as `{indicatorId, name, params, code}`. Each carries
    // its Pine source, which this component executes in the browser. `code` may
    // hold an unsaved draft so the editor can show what the author is typing
    // rather than the last saved version.
    indicators: { type: Array, default: () => [] },
    candleType: { type: String, default: 'candle_solid' },
    // Entry levels of the quick-trade positions, as `{side, size, entryPrice,
    // costLabel, entryLabel}`. Drawn as price lines because a horizontal level
    // is what the trader reads; the bundled canvas drew them as overlays.
    quickTradePositions: { type: Array, default: () => [] }
  },
  data () {
    return {
      handle: null,
      error: '',
      indicatorError: '',
      // Two host elements let the replacement chart paint before the old one is
      // torn down. Rebuilding is unavoidable (the study registry is read once at
      // mount), but the gap between `teardown` and `mount` is not: the new widget
      // is built behind the old one and only then does the old one go.
      hostSlot: 0,
      // Resolves when the mounted widget has drawn its first bars.
      whenReady: null,
      seriesCache: createSeriesCache(),
      // Bars, unlike the resolved plots, outlive a study rebuild: the same
      // symbol and timeframe answer every study the user checks and unchecks.
      barCache: createStudyBarCache(),
      // Market bars for the chart itself, kept across the rebuild that a changed
      // study set forces: without it the new widget re-downloads the window it
      // was just showing. See `createBarStore`.
      barStore: createBarStore(),
      // The last study set this component actually rebuilt for; see the
      // `indicators` watcher for why object identity cannot answer that.
      lastIndicatorsSignature: '',
      // What the library created, in creation order, so a live bar can update
      // those studies in place instead of rebuilding the widget.
      liveStudies: [],
      // Labels this component drew on the chart, kept so a redraw can remove the
      // previous set instead of stacking a second copy on top of it.
      drawnLabels: [],
      // Tables a study filled. The library's drawing API has no table primitive,
      // so they are rendered as positioned DOM over the chart.
      indicatorTables: [],
      // The most recent socket bar, waiting for the next resolve slot.
      liveBar: null,
      liveResolveTimer: null,
      positionLines: [],
      // The IDE resizes the mounted chart after a fullscreen change by calling
      // `chartRef.resize()`, a shape it inherited from the bundled canvas. The
      // library resizes itself from its container, so this is the smallest
      // object that keeps that call honest instead of throwing.
      chartRef: {
        resize: () => {
          window.dispatchEvent(new Event('resize'))
        }
      }
    }
  },
  watch: {
    symbol () {
      // The library has no public "change symbol" call that keeps its own
      // state coherent, so the mounted widget is replaced wholesale.
      this.barCache.clear()
      this.remount()
    },
    timeframe () {
      // A different period is a different series; keeping the old bars only
      // costs memory, since the cache key already keeps them apart.
      this.barCache.clear()
      this.remount()
    },
    theme () {
      this.remount()
    },
    indicators: {
      // A changed set is rebuilt rather than patched: the getter is consulted
      // once at mount, so a study that was not registered then cannot be drawn
      // later. The rebuild restores the visible range so it does not read as a
      // reload -- see `reconcileStudies`.
      //
      // The signature is what decides, not object identity. The parent hands
      // this prop over as the result of a method call, so every re-render of the
      // page produces a fresh array with the same contents -- and a deep watch on
      // object identity would treat each of those as a new study set, tearing
      // down the widget and downloading the whole history again. That is what a
      // request storm looks like from the network side.
      handler (next) {
        const signature = this.indicatorsSignature(next)
        if (signature === this.lastIndicatorsSignature) return
        this.lastIndicatorsSignature = signature
        this.reconcileStudies()
      }
    },
    quickTradePositions: {
      deep: true,
      handler () {
        this.drawPositionLines()
      }
    }
  },
  mounted () {
    this.mount()
  },
  beforeDestroy () {
    this.teardown()
    // The caches outlive every rebuild by design -- they are keyed by what
    // produced them, so remounting must not re-download history. They must not
    // outlive the component though, or a pane that closes leaves its bars and
    // study series in memory with nothing left to ask for them.
    this.barStore?.clear?.()
    this.barCache?.clear?.()
    this.seriesCache?.clear?.()
  },
  methods: {
    /**
     * A value that changes only when the study set really changes.
     *
     * Covers what the chart draws: which indicators, which code, which input
     * values. A re-sorted but otherwise identical list has the same signature,
     * because the chart draws the same lines either way.
     */
    indicatorsSignature (list) {
      const items = (list || []).map(item => {
        const params = item?.params && typeof item.params === 'object'
          ? Object.keys(item.params).sort().map(key => `${key}=${item.params[key]}`).join(',')
          : ''
        return [
          item?.indicatorId ?? item?.originalId ?? '',
          item?.name || '',
          params,
          String(item?.code || '').length,
          // A hash of the code rather than the code itself: the signature is
          // compared on every render, and a 2000-line script string would make
          // that comparison the expensive part.
          codeFingerprint(item?.code)
        ].join(':')
      })
      return items.join('|')
    },
    /** The host element for a slot, so a rebuild can target the hidden one. */
    hostFor (slot) {
      return slot === 1 ? this.$refs.chartHostSpare : this.$refs.chartHost
    },
    async mount (slot = this.hostSlot) {
      if (this.handle) return
      this.error = ''
      const container = this.hostFor(slot)
      if (!container) return
      try {
        this.handle = await mountTradingViewChart({
          container,
          market: this.market,
          symbol: this.symbol,
          exchangeId: this.exchangeId,
          marketType: this.marketType,
          instrumentId: this.instrumentId,
          timeframe: this.timeframe,
          theme: this.theme,
          locale: this.locale,
          customIndicators: () => this.loadIndicators(),
          barStore: this.barStore,
          // The quick-trade panel prefills its price from the chart's last
          // trade. The bundled canvas emitted this; without it the panel would
          // keep whatever price it last saw, which is worse than a stale label
          // because it is the number an order gets submitted at.
          //
          // The same push also feeds the study bar series: a study is a
          // precomputed array keyed by candle time, so a live bar the array has
          // never seen resolves to a gap and the study lines stop at the last
          // historical candle. Keeping the live bar in the series the studies
          // read is what makes them advance with the market.
          onRealtimeBar: ({ bar, resolution }) => {
            const close = Number(bar?.close)
            if (Number.isFinite(close) && close > 0) this.$emit('price-change', close)
            this.applyRealtimeBar(bar, resolution)
          }
        })
      } catch (err) {
        // A missing vendored bundle must not take the page down with it; the
        // message is what an operator needs to see.
        this.error = err?.message || String(err)
        return
      }
      // The registry is populated by the getter above, but nothing is drawn
      // until the chart exists. `onChartReady` is the point at which
      // `createStudy` stops resolving to null; drawing earlier is a silent
      // no-op, which is exactly how the studies went missing before.
      //
      // It is also the earliest moment the widget has bars on screen, which is
      // what a caller swapping this chart for a live one has to wait for: the
      // constructor returning means the canvas exists, not that it has drawn
      // anything, and revealing it then is the flash.
      const ready = new Promise((resolve) => {
        let settled = false
        const finish = () => {
          if (settled) return
          settled = true
          resolve()
        }
        this.handle.widget.onChartReady?.(() => {
          this.drawStudies()
          this.drawPositionLines()
          finish()
        })
        // A widget that never reports ready must not hang a rebuild forever; the
        // studies are drawn by then anyway on every library build we carry.
        setTimeout(finish, 1200)
      })
      this.whenReady = ready
    },
    /**
     * Bring the drawn studies in line with the checked set.
     *
     * Two facts about the library shape this:
     *
     * 1. `custom_indicators_getter` only *registers* studies -- the bundle pushes
     *    each definition into `studyLibrary` and stops there. Registering an
     *    indicator does not draw it; `createStudy` does. Earlier versions of this
     *    component registered and never drew, which is why checking a box changed
     *    nothing on the chart.
     * 2. The getter is asked once, when the widget is built. A study that was not
     *    registered then cannot be created later -- `createStudy` resolves to
     *    null for an unknown name.
     *
     * So a changed set means a rebuilt widget, and the job here is to make that
     * rebuild invisible: keep the visible time range and re-draw afterwards.
     * Rebuilding is also unavoidable for a changed draft, whose numbers are
     * different and which no call can swap in place.
     */
    async reconcileStudies () {
      if (!this.handle) return
      const viewport = this.captureViewport()
      // Nothing is cleared here. Every cache entry is keyed by what produced it
      // -- the script's revision, its parameter values, the series, the venue --
      // so an entry that is stale cannot be hit, and an entry that is still
      // valid is exactly what makes this rebuild cheap. Clearing threw that away
      // and re-ran every script on the chart for a checkbox.
      await this.remount()
      this.restoreViewport(viewport)
    },
    /** The visible time range, or null when it cannot be read. */
    captureViewport () {
      try {
        const range = this.handle?.widget?.activeChart?.()?.getVisibleRange?.()
        if (range && range.from && range.to) {
          return { from: range.from, to: range.to }
        }
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('getVisibleRange failed', err)
        }
      }
      return null
    },
    /**
     * Put the chart back where the user left it.
     *
     * Called after a rebuild so a checkbox toggle does not read as "the chart
     * reloaded": the bars come back in the same place, and only the study list
     * changes. A failure here leaves the default view, which is cosmetic — the
     * study set is what the user asked for.
     */
    restoreViewport (viewport) {
      if (!viewport) return
      try {
        this.handle?.widget?.activeChart?.()?.setVisibleRange?.(viewport)
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('setVisibleRange failed', err)
        }
      }
    },
    /**
     * Draw the studies whose definitions were registered at mount.
     *
     * Registered is not drawn: `custom_indicators_getter` fills the library's
     * study registry, and `createStudy` is what puts one on the chart. Both
     * steps are needed and only the first was happening.
     */
    async drawStudies () {
      if (!this.indicators.length) return
      const { indicators, failures } = await resolveCustomIndicators({
        indicators: this.indicators,
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        cache: this.seriesCache,
        barCache: this.barCache
      })
      this.reportFailures(failures)
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart) return
      // Collected in creation order so a live bar can update these studies
      // instead of rebuilding the widget: the position in this array is the
      // only handle the library gives back that lines a study up with the
      // resolved output.
      const created = []
      for (const study of indicators) {
        try {
          // Overlay placement comes from the study's own metainfo; forcing the
          // overlay flag here would fight the indicator author's intent.
          // eslint-disable-next-line no-await-in-loop
          await chart.createStudy(study.name, study.metainfo.overlay === true, false, {})
          created.push(study)
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('createStudy failed', study.name, err)
          }
        }
      }
      this.liveStudies = created
      this.drawStudyDrawings(created)
    },
    /**
     * Draw what the study's plot table cannot carry.
     *
     * A `label.new` is a point with a price and a bar time, which the library's
     * shape API takes directly. A `table.*` has no drawing primitive at all, so
     * its cells are rendered as positioned DOM over the pane.
     */
    drawStudyDrawings (studies) {
      this.clearStudyDrawings()
      const list = Array.isArray(studies) ? studies : []
      const tables = []
      for (const study of list) {
        if (Array.isArray(study.tables) && study.tables.length) {
          tables.push(...study.tables.map(table => ({ ...table, studyName: study.name })))
        }
      }
      this.indicatorTables = tables
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.createShape !== 'function') return
      const pending = []
      for (const study of list) {
        for (const label of Array.isArray(study.labels) ? study.labels : []) {
          // `style_none` draws no box in Pine -- only the hover text -- and the
          // library's text tool always draws something, so those are skipped
          // rather than drawn as an empty label.
          if (!label.boxed) continue
          if (!Number.isFinite(label.time)) continue
          const point = Number.isFinite(label.price)
            ? { time: Math.floor(label.time / 1000), price: label.price }
            : { time: Math.floor(label.time / 1000) }
          pending.push(
            chart.createShape(point, {
              shape: 'text',
              lock: true,
              // The label belongs to the study, not to the user's annotations:
              // it must not be selectable, saved, or on the undo stack.
              disableSelection: true,
              disableSave: true,
              disableUndo: true,
              showInObjectsTree: false,
              text: label.text,
              overrides: labelOverrides(label)
            }).catch(() => null)
          )
        }
      }
      // Kept for the next redraw to remove; a shape the library refused is not
      // tracked, so a failure cannot leave the removal list holding a dead id.
      Promise.all(pending).then(ids => {
        this.drawnLabels = ids.filter(id => id !== null)
      }).catch(() => {})
    },
    clearStudyDrawings () {
      const chart = this.handle?.widget?.activeChart?.()
      const ids = this.drawnLabels
      this.drawnLabels = []
      this.indicatorTables = []
      if (!chart || typeof chart.removeEntity !== 'function') return
      for (const id of ids) {
        try {
          chart.removeEntity(id)
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('removeEntity failed', err)
          }
        }
      }
    },
    /** Position and colours for one Pine table, as the DOM overlay needs them. */
    tableStyle (table) {
      const style = { borderColor: table.borderColor || 'transparent' }
      if (table.backgroundColor) style.backgroundColor = table.backgroundColor
      return style
    },
    /**
     * One table's cells grouped by row.
     *
     * The runtime hands back a flat, sparse list; rendering needs rows, and the
     * gaps have to stay gaps -- a missing cell is a hole in the layout, not a
     * cell that should slide left.
     */
    tableRows (table) {
      const byRow = new Map()
      for (const cell of Array.isArray(table.cells) ? table.cells : []) {
        if (!byRow.has(cell.row)) byRow.set(cell.row, [])
        byRow.get(cell.row).push(cell)
      }
      return [...byRow.keys()].sort((a, b) => a - b).map(index => ({
        index,
        cells: byRow.get(index).sort((a, b) => a.column - b.column)
      }))
    },
    cellStyle (cell) {
      const style = {}
      if (cell.textColor) style.color = cell.textColor
      if (cell.backgroundColor) style.backgroundColor = cell.backgroundColor
      if (cell.textSize) style.fontSize = `${LABEL_FONT_SIZE[cell.textSize] || LABEL_FONT_SIZE.normal}px`
      return style
    },
    reportFailures (failures) {
      const list = Array.isArray(failures) ? failures : []
      this.indicatorError = list.length
        ? list.map(item => `${item.indicatorId}: ${item.reason}`).join('; ')
        : ''
      this.$emit('indicator-error', this.indicatorError)
    },
    /**
     * Resolve the studies the chart should draw.
     *
     * A failed indicator is reported through `indicatorError` and skipped: the
     * chart is still correct without it, whereas an exception here would leave
     * the user with an empty pane and no explanation.
     */
    async loadIndicators () {
      if (!this.indicators.length) return []
      const { indicators, failures } = await resolveCustomIndicators({
        indicators: this.indicators,
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        cache: this.seriesCache,
        barCache: this.barCache
      })
      this.reportFailures(failures)
      // Registered here, drawn by `drawStudies` once the widget reports ready.
      // The library only takes the registry from this getter; it never puts a
      // study on the chart by itself.
      return indicators
    },
    /**
     * Redraw after the study set changed.
     *
     * `indicators` is watched, so this is normally automatic; the method exists
     * because the IDE calls `updateIndicators()` on whatever chart it mounted
     * and a silent no-op would leave a stale study on screen.
     */
    async updateIndicators () {
      // The same gate the watcher uses. This method is called from the IDE on
      // every selection change -- selecting an indicator to edit does not change
      // what is drawn -- and reconciling unconditionally tore the widget down
      // and reloaded the series for a click that changed nothing on the chart.
      const signature = this.indicatorsSignature(this.indicators)
      if (this.handle && signature === this.lastIndicatorsSignature) return
      this.lastIndicatorsSignature = signature
      await this.reconcileStudies()
    },
    /**
     * Advance the studies onto the bar the socket just delivered.
     *
     * A study here is output computed from a fixed window of bars, keyed by
     * candle time, so a candle it has never seen resolves to a gap: the lines
     * stop at the last closed bar while the price keeps moving. That is the
     * one part of the chart that did not follow the market.
     *
     * Recorded rather than recomputed on the spot: a venue pushes several ticks
     * a second and every tick would re-run every checked script. The bar is
     * kept, a pass is scheduled at most once per `LIVE_RESOLVE_MS`, and the
     * pass runs the studies over the series that now includes that bar.
     *
     * No widget rebuild: the study instance the library holds is told to read
     * a new lookup (`update`), which is all a study that only grew by one bar
     * needs. Rebuilding here is what would make a live chart flicker.
     */
    applyRealtimeBar (bar, resolution) {
      if (!bar || !this.indicators.length) return
      // Only the resolution the chart is showing moves its own studies: a
      // socket pushing an hourly bar has nothing to say about a daily study.
      if (resolution && resolution !== intervalFor(this.timeframe)) return
      this.liveBar = bar
      if (this.liveResolveTimer) return
      this.liveResolveTimer = setTimeout(() => {
        this.liveResolveTimer = null
        this.refreshLiveStudies()
      }, LIVE_RESOLVE_MS)
    },
    /**
     * Recompute the drawn studies over the series that now includes the live
     * bar, and point each one at its new output.
     *
     * `liveStudies` holds what `drawStudies`/`loadIndicators` built, in the
     * same order the library created them, so a study can be updated by
     * position instead of being torn down and recreated.
     */
    async refreshLiveStudies () {
      if (!this.handle || !this.liveBar || !this.liveStudies.length) return
      const bar = this.liveBar
      this.liveBar = null
      const touched = this.barCache.rememberLive(bar, this.timeframe)
      if (!touched.length) return
      // The outputs were computed before this bar existed, so their cache
      // entries describe a series that no longer exists. Clearing is honest
      // here; the entries are rebuilt from the same download.
      this.seriesCache.clear()
      try {
        const { indicators } = await resolveCustomIndicators({
          indicators: this.indicators,
          market: this.market,
          symbol: this.symbol,
          timeframe: this.timeframe,
          cache: this.seriesCache,
          barCache: this.barCache
        })
        // Matched on the series key, not on position: one study failing to
        // resolve would otherwise shift every later study onto the previous
        // study's instance. A study with no match simply keeps its old output.
        const byKey = new Map(this.liveStudies.map(study => [study.key, study]))
        let drawingsMoved = false
        for (const next of indicators) {
          const target = byKey.get(next.key)
          if (!target) continue
          const moved = target.update?.({ plots: next.series, candleTimes: next.candleTimes, labels: next.labels, tables: next.tables })
          if (moved && ((next.labels || []).length || (next.tables || []).length)) drawingsMoved = true
        }
        // Labels and tables sit at bar positions, so a new bar moves them. Only
        // redrawn when a study actually carried some: removing and recreating
        // shapes on every tick would make them flicker for no reason.
        if (drawingsMoved) this.drawStudyDrawings(this.liveStudies)
        this.handle?.widget?.activeChart?.()?.refreshMarks?.()
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('live study refresh failed', err)
        }
      }
    },
    /**
     * A canvas snapshot for the marketplace preview.
     *
     * The library has the screenshot; our caller used to get one from the
     * bundled canvas. Returning a data URL keeps the publish path unchanged.
     */
    async captureMarketPreview (options = {}) {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.takeClientScreenshot !== 'function') return ''
      try {
        const canvas = await chart.takeClientScreenshot({
          // The library's own watermark is already part of the picture; asking
          // for it twice would stamp the preview twice.
          hideResolution: false
        })
        if (!canvas) return ''
        const target = document.createElement('canvas')
        const width = Math.max(640, Number(options.width) || canvas.width)
        const height = Math.max(360, Number(options.height) || canvas.height)
        target.width = width
        target.height = height
        const context = target.getContext('2d')
        if (!context) return ''
        // Letterbox rather than stretch: a squashed chart misreads the pattern
        // the preview is meant to show.
        const scale = Math.min(width / canvas.width, height / canvas.height)
        const drawWidth = canvas.width * scale
        const drawHeight = canvas.height * scale
        context.fillStyle = this.theme === 'dark' ? '#131722' : '#ffffff'
        context.fillRect(0, 0, width, height)
        context.drawImage(canvas, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight)
        return target.toDataURL('image/png')
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('takeClientScreenshot failed', err)
        }
        return ''
      }
    },
    /**
     * Draw the entry level of each open position.
     *
     * A trader reads the entry as a horizontal level against the live price, so
     * a price line is the honest drawing; the previous renderer drew it as an
     * overlay with a label, which is the same information on a different
     * primitive. Lines are removed before being redrawn because the library has
     * no "update this line" call.
     */
    drawPositionLines () {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.createOrderLine !== 'function') return
      for (const line of this.positionLines) {
        try {
          line.remove()
        } catch (_error) {
          // A line whose chart went away is already gone.
        }
      }
      this.positionLines = []
      const positions = Array.isArray(this.quickTradePositions) ? this.quickTradePositions : []
      for (const position of positions) {
        const price = Number(position?.entryPrice)
        if (!Number.isFinite(price) || price <= 0) continue
        const side = position?.side === 'short' ? 'short' : 'long'
        const colour = side === 'short' ? '#f04438' : '#12b76a'
        // Deliberately not awaited in order: each line is independent, and
        // awaiting them serially would make a five-position account pay five
        // round trips before the last line appears.
        Promise.resolve(chart.createOrderLine())
          .then((line) => {
            if (!line) return
            line.setPrice(price)
            line.setLineStyle(2)
            line.setLineColor(colour)
            line.setText(`${String(position?.costLabel || '')} ${side === 'short' ? '▼' : '▲'}`.trim())
            line.setQuantity('')
            line.setEditable(false)
            this.positionLines.push(line)
          })
          .catch((error) => {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('createOrderLine failed', error)
            }
          })
      }
    },
    teardown () {
      if (!this.handle) return
      this.positionLines = []
      // Tables are DOM, labels are chart shapes; both belong to the widget that
      // is about to go.
      this.indicatorTables = []
      this.drawnLabels = []
      // Vue observes this array deeply, so every study object and every number
      // in its series carries a getter/setter. The instances die with the
      // widget, so holding them keeps a whole study-set's worth of reactive
      // numbers alive for nothing -- measured at ~250KB per study.
      this.liveStudies = []
      try {
        this.handle.destroy()
      } finally {
        this.handle = null
      }
    },
    /**
     * Replace the widget without showing the page a blank chart.
     *
     * `teardown()` then `mount()` leaves an empty pane for as long as the new
     * widget takes to build, which is what the flicker was. The next widget is
     * built into the hidden host instead and the visible host is only retired
     * once the replacement reports ready -- so the old chart stays on screen
     * until the new one can cover it.
     */
    async remount () {
      const previous = this.handle
      const previousSlot = this.hostSlot
      const nextSlot = previousSlot === 0 ? 1 : 0
      // `mount` refuses while a handle exists, so the old one is detached from
      // the field first and destroyed by hand if the new mount fails.
      this.handle = null
      try {
        await this.mount(nextSlot)
      } catch (err) {
        this.handle = previous
        this.hostSlot = previousSlot
        throw err
      }
      if (!this.handle) {
        this.handle = previous
        this.hostSlot = previousSlot
        return
      }
      // Mounted is not drawn: the constructor returns once the canvas exists, and
      // its bars arrive afterwards. Revealing it at that point is the flash the
      // user sees -- an empty pane over the old chart. Waiting for the ready
      // signal is what makes the swap invisible.
      try {
        await this.whenReady
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('replacement chart never became ready', err)
        }
      }
      // The replacement is drawn and its container is the one the template now
      // marks active; only now does the old widget stop drawing.
      this.hostSlot = nextSlot
      await this.$nextTick()
      try {
        previous?.destroy()
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('previous chart teardown threw', err)
        }
      }
    }
  }
}
</script>

<style lang="less" scoped>
.tv-chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 420px;

  &__host {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    // Hidden rather than unmounted: the replacement chart has to be able to
    // build at full size before it is shown, or it lays out at a wrong width and
    // then jumps. Only the active host takes clicks.
    visibility: hidden;
    pointer-events: none;

    &--active {
      visibility: visible;
      pointer-events: auto;
    }
  }

  // Pine tables, as the DOM the library has no primitive for. Positioned in the
  // pane corners the script names, above the chart but taking no clicks.
  &__tables {
    position: absolute;
    inset: 0;
    pointer-events: none;
    overflow: hidden;
  }

  &__table {
    position: absolute;
    margin: 0;
    font-family: 'Trebuchet MS', Roboto, Ubuntu, sans-serif;
    font-size: 12px;
    line-height: 1.3;
    border-collapse: collapse;
    border: 1px solid transparent;
    pointer-events: auto;

    td {
      padding: 2px 5px;
      white-space: nowrap;
      text-align: center;
      vertical-align: middle;
    }

    &--top-right { top: 8px; right: 64px; }
    &--top-left { top: 8px; left: 8px; }
    &--top-center { top: 8px; left: 50%; transform: translateX(-50%); }
    &--middle-center { top: 50%; left: 50%; transform: translate(-50%, -50%); }
    &--middle-left { top: 50%; left: 8px; transform: translateY(-50%); }
    &--bottom-right { bottom: 28px; right: 64px; }
    &--bottom-left { bottom: 28px; left: 8px; }
    // The 28px clears the library's own bottom-right legend, which a table
    // would otherwise sit on top of.
    &--bottom-center { bottom: 28px; left: 50%; transform: translateX(-50%); }
  }

  &__warning {
    position: absolute;
    right: 8px;
    bottom: 8px;
    max-width: 60%;
    padding: 4px 8px;
    font-size: 12px;
    color: #d48806;
    background: rgba(0, 0, 0, 0.45);
    border-radius: 4px;
  }

  &__error {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    font-size: 13px;
    text-align: center;
    color: #ff7875;
    background: rgba(0, 0, 0, 0.35);
  }
}
</style>
