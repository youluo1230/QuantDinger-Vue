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
import { chartTypeForSeriesType, createBarStore, intervalFor, mountTradingViewChart, seriesTypeFor } from '@/charting/tradingview'
import { timeframeFromResolution } from '@/charting/datafeed'
import { encodeSymbolTicker } from '@/charting/symbolTicker'
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
    compactHeader: { type: Boolean, default: false },
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
      // The study instances the library actually created, keyed by the entity
      // id it handed back. This is the only handle that lets a value edited in
      // the native Settings dialog be read back (`getInputValues`) and turned
      // into a new evaluation without recreating the widget.
      studyRecords: [],
      // Input values edited in the native Settings dialog, keyed by study name.
      // The list the parent passes still holds the saved indicator's values, so
      // without this every live bar would re-run the script with the old inputs
      // and undo the edit. Cleared with the component; persisting it is the
      // workspace-archive work.
      studyParams: {},
      // Study names the mounted widget's `custom_indicators_getter` registered.
      // `createStudy` resolves to null for a name that was not there at mount,
      // so this decides whether a set change can be applied in place or needs
      // the rebuild fallback.
      registeredStudyNames: [],
      // The promise the library's `custom_indicators_getter` received. The
      // getter and `drawStudies` must resolve the same list: if they resolved
      // separately, a study could be created before the registry it was drawn
      // from was pushed into the library, which surfaces as "unknown study name".
      registryPromise: null,
      registrySignature: '',
      // A rebuild already retried after a study could not be created. Guards
      // against a registry that never settles rebuilding in a loop.
      studyRetry: false,
      // Teardown callbacks for the chart subscriptions (interval, symbol).
      chartUnsubscribes: [],
      // Labels this component drew on the chart, kept so a redraw can remove the
      // previous set instead of stacking a second copy on top of it.
      drawnLabels: [],
      // Tables a study filled. The library's drawing API has no table primitive,
      // so they are rendered as positioned DOM over the chart.
      indicatorTables: [],
      // A rebuild asked for while one is already in flight must not start a
      // second widget: two consecutive `mount` calls would race for the spare
      // host. The request is remembered and applied after the first finishes.
      remounting: false,
      remountQueued: false,
      // The most recent socket bar, waiting for the next resolve slot.
      liveBar: null,
      liveResolveTimer: null,
      positionLines: []
    }
  },
  computed: {
    /**
     * Everything that decides which data this widget must show.
     *
     * One watcher rather than four: a symbol picked in the library's search
     * arrives as instrument *and* venue, and a venue change alone is enough to
     * point the same pair at a different market. Watching the parts separately
     * fired one rebuild per changed field -- and two rebuilds in one tick race
     * for the spare host.
     */
    dataContext () {
      return [
        this.symbol,
        this.market,
        this.exchangeId,
        this.marketType,
        this.instrumentId,
        this.timeframe
      ].join('|')
    }
  },
  watch: {
    dataContext () {
      // The library has no public "change symbol" call that keeps its own
      // state coherent, so the mounted widget is replaced wholesale. Every
      // store is dropped, because none of them is keyed by venue: a swap from
      // spot to perpetual on the same pair would otherwise replay the previous
      // subscription's bars and plot the previous venue's prices under the new
      // legend, which reads as a data bug rather than a cache hit.
      this.barCache.clear()
      this.barStore.clear()
      this.seriesCache.clear()
      this.remount()
    },
    theme () {
      this.remount()
    },
    compactHeader () {
      // Which header controls are enabled cannot change after construction.
      this.remount()
    },
    candleType () {
      // The style is a property of the chart, not of the data: switching it
      // must not rebuild the widget or re-run a single script.
      this.applyChartType()
    },
    indicators: {
      // A changed set is applied in place when the names were all registered at
      // mount, and rebuilt only when one was not: the getter is consulted once
      // at mount, so a study it never saw cannot be created later. Both paths
      // preserve the visible range so the change does not read as a reload.
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
        this.syncStudies()
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
          compactHeader: this.compactHeader,
          customIndicators: () => this.loadIndicators(),
          barStore: this.barStore,
          // The datafeed sees a symbol change before the chart does, and its
          // symbolInfo carries the venue the encoded ticker decoded to. It is
          // the only callback that knows a search result's venue; the chart
          // subscription below reports the same change one frame later.
          onSymbolResolved: (info) => this.onLibrarySymbolResolved(info),
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
          this.applyChartType()
          this.subscribeChartEvents()
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
    /**
     * Layer the Settings-dialog values over the indicators the pane handed in.
     *
     * Precedence is per input title: a value the user picked wins over the
     * saved one, everything else keeps following the editor. The name is the
     * key because it is what the library uses to address a study.
     */
    withStudyParams (indicators) {
      const list = Array.isArray(indicators) ? indicators : []
      return list.map(item => {
        const overrides = this.studyParams[item?.name || '']
        if (!overrides) return item
        return { ...item, params: { ...(item?.params || {}), ...overrides } }
      })
    },
    /** Resolve the checked indicators against the current series. */
    resolveStudies (indicators = this.indicators) {
      return resolveCustomIndicators({
        indicators: this.withStudyParams(indicators),
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        exchangeId: this.exchangeId,
        marketType: this.marketType,
        instrumentId: this.instrumentId,
        cache: this.seriesCache,
        barCache: this.barCache
      })
    },
    /**
     * The values a study's inputs start from, as `createStudy` wants them.
     *
     * The library keys inputs by id (`in_<n>`) and values by type; both come
     * from the same spec list the native Settings dialog renders, so the first
     * picture and the dialog cannot disagree.
     */
    studyInputValues (study) {
      const values = {}
      for (const input of Array.isArray(study?.inputs) ? study.inputs : []) {
        if (input && input.id) values[input.id] = input.defval
      }
      return values
    },
    async drawStudies () {
      this.studyRecords = []
      this.liveStudies = []
      if (!this.indicators.length) {
        this.registeredStudyNames = []
        return
      }
      // The getter and this method share one promise (see `loadIndicators`),
      // and the registry is filled from the library's own continuation. A turn
      // of the event loop separates the two: without it `createStudy` can beat
      // the registration it depends on and the chart reports an unknown study.
      const indicators = await this.loadIndicators()
      await new Promise(resolve => setTimeout(resolve, 0))
      if (!indicators.length) return
      // The names the getter just registered: a later set change can use these
      // in place, and only a name outside this list forces a rebuild.
      this.registeredStudyNames = indicators.map(study => study.name)
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart) return
      const records = []
      for (const study of indicators) {
        try {
          // Overlay placement comes from the study's own metainfo; forcing the
          // overlay flag here would fight the indicator author's intent.
          // eslint-disable-next-line no-await-in-loop
          const entityId = await chart.createStudy(study.name, study.metainfo.overlay === true, false, this.studyInputValues(study))
          if (entityId) {
            this.studyRetry = false
            records.push({
              entityId,
              indicatorId: Number(study.indicatorId || 0),
              name: study.name,
              key: study.key,
              descriptor: study,
              params: { ...(study.params || {}) }
            })
          } else {
            // The library only refuses a name it does not hold. One rebuild
            // re-reads the registry; retrying on its own would loop.
            this.retryStudySet()
          }
        } catch (err) {
          this.retryStudySet()
          if (process.env.NODE_ENV !== 'production') {
            console.debug('createStudy failed', study.name, err)
          }
        }
      }
      this.studyRecords = records
      this.liveStudies = records.map(record => record.descriptor)
      this.drawStudyDrawings(this.liveStudies)
    },
    /**
     * Re-read the registry once when a study could not be created.
     *
     * The library reports "unknown study name" itself when `createStudy` gets a
     * name its registry does not hold. The causes are a registry that had not
     * settled and, rarely, a stale widget; a single rebuild fixes both, and the
     * guard keeps a genuinely broken script from rebuilding forever.
     */
    retryStudySet () {
      if (this.studyRetry) return
      this.studyRetry = true
      setTimeout(() => {
        if (this._isDestroyed || !this.handle) return
        this.remount()
      }, 400)
    },
    /**
     * Bring the drawn studies in line with the checked set without a rebuild.
     *
     * The library can add and remove studies on a live chart (`createStudy`,
     * `removeEntity`), and for a set change that is all that is needed: the
     * scripts are already registered, the bars are cached, and no widget state
     * depends on the study list. A rebuild is reserved for the one case the
     * library really cannot do -- showing a script whose name it was never told
     * about at mount, because the getter is read once.
     */
    async syncStudies () {
      if (!this.handle) return
      const { indicators, failures } = await this.resolveStudies()
      this.reportFailures(failures)
      // Two indicators can share a display name, and the library addresses a
      // study by that name. Rather than guess which duplicate a set change
      // meant, a duplicate name is treated as "not safely patchable".
      const names = indicators.map(study => study.name)
      const unique = new Set(names).size === names.length
      const known = unique && indicators.every(study => this.registeredStudyNames.includes(study.name))
      if (!known) {
        const viewport = this.captureViewport()
        await this.remount()
        this.restoreViewport(viewport)
        return
      }
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart) return
      const wanted = new Set(names)
      for (const record of [...this.studyRecords]) {
        if (wanted.has(record.name)) continue
        try {
          this._selfRemovedEntities = this._selfRemovedEntities || new Set()
          this._selfRemovedEntities.add(record.entityId)
          chart.removeEntity(record.entityId)
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('removeEntity failed', record.name, err)
          }
        }
        this.studyRecords = this.studyRecords.filter(item => item !== record)
      }
      for (const study of indicators) {
        const existing = this.studyRecords.find(record => record.name === study.name)
        if (existing) {
          // The library's own `Study` instance reads the lookup built by the
          // descriptor it was created from, so the update has to run on that
          // descriptor -- swapping in a fresh one would leave the chart drawing
          // whatever the old closure last computed. A set change cannot change
          // the plot table either, so refreshing the values is enough.
          existing.descriptor.update?.({
            plots: study.series,
            candleTimes: study.candleTimes,
            labels: study.labels,
            tables: study.tables
          })
          existing.key = study.key
          existing.params = { ...(study.params || {}) }
          continue
        }
        try {
          // eslint-disable-next-line no-await-in-loop
          const entityId = await chart.createStudy(study.name, study.metainfo.overlay === true, false, this.studyInputValues(study))
          if (entityId) {
            this.studyRetry = false
            this.studyRecords.push({
              entityId,
              indicatorId: Number(study.indicatorId || 0),
              name: study.name,
              key: study.key,
              descriptor: study,
              params: { ...(study.params || {}) }
            })
          } else {
            this.retryStudySet()
          }
        } catch (err) {
          this.retryStudySet()
          if (process.env.NODE_ENV !== 'production') {
            console.debug('createStudy failed', study.name, err)
          }
        }
      }
      this.liveStudies = this.studyRecords.map(record => record.descriptor)
      this.drawStudyDrawings(this.liveStudies)
    },
    /**
     * The chart's style, from the IDE's chart-type name.
     *
     * `setChartType` is a property change, not a data change: no bars move and
     * no study re-runs, which is why the toolbar can offer it without the
     * flicker a rebuild would cost.
     */
    applyChartType () {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.setChartType !== 'function') return
      try {
        chart.setChartType(seriesTypeFor(this.candleType))
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('setChartType failed', err)
        }
      }
    },
    /**
     * Ask the library to re-measure. It sizes itself from its container, so a
     * layout change outside the chart (a fullscreen swap, the editor drawer
     * opening) only needs this nudge.
     */
    resize () {
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.resize !== 'function') return
      try {
        chart.resize()
      } catch (_) {}
    },
    /**
     * Listen for the controls the library now owns.
     *
     * The chart's own header can change the interval and the symbol; the IDE's
     * pane state has to follow, or the next rebuild would put the chart back on
     * the symbol the pane still believes in.
     */
    subscribeChartEvents () {
      const widget = this.handle?.widget
      const chart = widget?.activeChart?.()
      if (!widget || !chart) return
      try {
        if (typeof widget.subscribe === 'function') {
          widget.subscribe('study_properties_changed', this.onStudyPropertiesChanged)
        }
        widget.subscribe?.('study_event', this.onLibraryStudyEvent)
        const offInterval = chart.onIntervalChanged?.()
        offInterval?.subscribe?.(null, (interval) => this.onLibraryIntervalChanged(interval))
        const offSymbol = chart.onSymbolChanged?.()
        offSymbol?.subscribe?.(null, (info) => this.onLibrarySymbolResolved(info))
        const offType = chart.onChartTypeChanged?.()
        offType?.subscribe?.(null, (seriesType) => this.onLibraryChartTypeChanged(seriesType))
        // The subscriptions outlive the callbacks' usefulness the moment the
        // widget is destroyed; unsubscribing explicitly is what keeps a rebuilt
        // chart from calling into a dead component.
        this.chartUnsubscribes.push(() => {
          try {
            widget.unsubscribe?.('study_properties_changed', this.onStudyPropertiesChanged)
            widget.unsubscribe?.('study_event', this.onLibraryStudyEvent)
            offInterval?.unsubscribe?.(null)
            offSymbol?.unsubscribe?.(null)
            offType?.unsubscribe?.(null)
          } catch (err) {
            if (process.env.NODE_ENV !== 'production') {
              console.debug('chart unsubscribe failed', err)
            }
          }
        })
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('chart subscription failed', err)
        }
      }
    },
    /**
     * The header's style picker, as the pane's chart type.
     *
     * `applyChartType` writes the IDE's name into the library; the library
     * reports the series back, and only a series the pane did not ask for is a
     * user change. Comparing series instead of names keeps that write from
     * echoing back as a change (several names share one series).
     */
    /**
     * The legend's own delete button, as an edit to the pane.
     *
     * Removals this component starts itself are already reflected in
     * `studyRecords`; only a study the user removed through the library's
     * legend needs to travel back up to the pane that asked for it.
     */
    onLibraryStudyEvent (entityId, eventType) {
      if (eventType !== 'remove' || !entityId) return
      this._selfRemovedEntities = this._selfRemovedEntities || new Set()
      if (this._selfRemovedEntities.delete(entityId)) return
      const record = this.studyRecords.find(item => item.entityId === entityId)
      if (!record) return
      this.studyRecords = this.studyRecords.filter(item => item !== record)
      this.liveStudies = this.studyRecords.map(item => item.descriptor)
      this.$emit('study-removed', { indicatorId: record.indicatorId, name: record.name })
    },
    onLibraryChartTypeChanged (seriesType) {
      if (Number(seriesType) === seriesTypeFor(this.candleType)) return
      const chartType = chartTypeForSeriesType(seriesType)
      if (!chartType) return
      this.$emit('chart-type-change', { chartType })
    },
    /** The header's interval picker, as the pane's timeframe. */
    onLibraryIntervalChanged (interval) {
      const timeframe = timeframeFromResolution(interval)
      if (!timeframe || timeframe === this.timeframe) return
      this.$emit('interval-change', { timeframe })
    },
    /**
     * A symbol the library resolved, reported back to the pane.
     *
     * The library prints a bare title for a bare symbol, and the pane already
     * knows which venue it holds; only a symbol that carries a venue (the
     * encoded ticker a search result returns) has something new to say.
     */
    onLibrarySymbolResolved (info) {
      const ticker = String(info?.ticker || '').trim()
      if (!ticker) return
      const current = encodeSymbolTicker({
        market: this.market,
        marketType: this.marketType,
        exchangeId: this.exchangeId,
        instrumentId: this.instrumentId,
        symbol: this.symbol
      })
      if (ticker === current) return
      this.$emit('symbol-change', {
        ticker,
        market: String(info.market || this.market),
        marketType: String(info.marketType || ''),
        exchangeId: String(info.exchangeId || ''),
        instrumentId: String(info.instrumentId || ''),
        symbol: String(info.instrument || info.name || '')
      })
    },
    /**
     * A value edited in the native Settings dialog.
     *
     * The dialog owns the values; this side owns the evaluation. Reading them
     * back through `getInputValues` and re-running the script is what keeps the
     * two in sync -- and the ids are the same `in_<n>` handles the metainfo
     * advertised, so the mapping back to a Pine title is exact.
     */
    async onStudyPropertiesChanged (entityId) {
      const record = this.studyRecords.find(item => item.entityId === entityId)
      if (!record) return
      const chart = this.handle?.widget?.activeChart?.()
      if (!chart || typeof chart.getStudyById !== 'function') return
      let values = []
      try {
        values = chart.getStudyById(entityId).getInputValues() || []
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('getInputValues failed', err)
        }
        return
      }
      const inputMap = record.descriptor?.inputMap || {}
      const params = {}
      let changed = false
      for (const item of values) {
        const title = inputMap[item?.id]
        if (!title) continue
        params[title] = item.value
        // The dialog hands back numbers and the script's overrides arrive as
        // strings, so a strict compare would call every open a change and rerun
        // the script for nothing.
        if (String(record.params?.[title] ?? '') !== String(item.value ?? '')) changed = true
      }
      if (!changed) return
      const source = (this.indicators || []).find(item => (item?.name || '') === record.name)
      if (!source) return
      try {
        const { indicators } = await resolveCustomIndicators({
          indicators: [{ ...source, params: { ...(source.params || {}), ...params } }],
          market: this.market,
          symbol: this.symbol,
          timeframe: this.timeframe,
          exchangeId: this.exchangeId,
          marketType: this.marketType,
          instrumentId: this.instrumentId,
          cache: this.seriesCache,
          barCache: this.barCache
        })
        const next = indicators && indicators[0]
        if (!next) return
        // Only after the re-evaluation succeeded: a failed run must leave both
        // the record and the chart on the values they were showing.
        this.$set(this.studyParams, record.name, params)
        record.params = params
        // The workspace archive has to carry the values the dialog produced;
        // the parent stores them per indicator and saves them with the chart.
        if (record.indicatorId > 0) {
          this.$emit('indicator-params-change', {
            indicatorId: record.indicatorId,
            params: { ...params }
          })
        }
        // Deliberately the same descriptor: the library holds the `Study`
        // instance that descriptor built, and only that closure can refresh
        // what the chart is drawing.
        record.descriptor.update?.({ plots: next.series, candleTimes: next.candleTimes, labels: next.labels, tables: next.tables })
        record.key = next.key
        this.liveStudies = this.studyRecords.map(item => item.descriptor)
        this.drawStudyDrawings(this.liveStudies)
        this.handle?.widget?.activeChart?.()?.refreshMarks?.()
      } catch (err) {
        if (process.env.NODE_ENV !== 'production') {
          console.debug('study input re-evaluation failed', record.name, err)
        }
      }
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
    loadIndicators () {
      if (!this.indicators.length) return []
      // The getter is asked once per widget; `drawStudies` asks for the same
      // list a moment later. Resolving twice would let `createStudy` run
      // against a registry the library had not finished filling, so both call
      // sites share one promise. The signature keeps a changed set honest.
      const signature = this.indicatorsSignature(this.indicators)
      if (this.registryPromise && this.registrySignature === signature) {
        return this.registryPromise
      }
      const promise = this.resolveIndicatorRegistry()
      this.registrySignature = signature
      this.registryPromise = promise
      return promise
    },
    /**
     * Resolve the studies the widget needs for the current set.
     *
     * Registered here, drawn by `drawStudies` once the widget reports ready.
     * The library only takes the registry from the getter; it never puts a
     * study on the chart by itself.
     */
    async resolveIndicatorRegistry () {
      const { indicators, failures } = await resolveCustomIndicators({
        indicators: this.withStudyParams(this.indicators),
        market: this.market,
        symbol: this.symbol,
        timeframe: this.timeframe,
        exchangeId: this.exchangeId,
        marketType: this.marketType,
        instrumentId: this.instrumentId,
        cache: this.seriesCache,
        barCache: this.barCache
      })
      this.reportFailures(failures)
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
      await this.syncStudies()
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
          indicators: this.withStudyParams(this.indicators),
          market: this.market,
          symbol: this.symbol,
          timeframe: this.timeframe,
          exchangeId: this.exchangeId,
          marketType: this.marketType,
          instrumentId: this.instrumentId,
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
      for (const off of this.chartUnsubscribes) {
        try {
          off()
        } catch (err) {
          if (process.env.NODE_ENV !== 'production') {
            console.debug('chart teardown failed', err)
          }
        }
      }
      this.chartUnsubscribes = []
      this.studyRecords = []
      this.liveStudies = []
      this.studyParams = {}
      this.registeredStudyNames = []
      this.positionLines = []
      // Tables are DOM, labels are chart shapes; both belong to the widget that
      // is about to go.
      this.indicatorTables = []
      this.drawnLabels = []
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
      if (this.remounting) {
        // Coalesce: by the time the in-flight rebuild finishes, the props hold
        // the latest values, so one more pass is all a burst of changes needs.
        this.remountQueued = true
        return
      }
      this.remounting = true
      try {
        await this.swapChart()
      } finally {
        this.remounting = false
        if (this.remountQueued) {
          this.remountQueued = false
          this.remount()
        }
      }
    },
    async swapChart () {
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
  // The pane owns the height. A floor here made a four-pane layout taller than
  // its grid cells at common laptop sizes, and the chart was clipped mid-candle.
  min-height: 0;

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
