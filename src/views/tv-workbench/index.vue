<template>
  <div class="tv-workbench qd-workspace-page qd-page-frame" :class="{ 'theme-dark': isDarkTheme }">
    <header class="page-header">
      <div>
        <span class="kicker">{{ t('tvWorkbench.kicker') }}</span>
        <h1>{{ t('tvWorkbench.title') }}</h1>
        <p>{{ t('tvWorkbench.subtitle') }}</p>
      </div>
      <div class="header-actions">
        <a-select
          v-model="selectedAssetKey"
          class="asset-select"
          show-search
          :filter-option="filterAsset"
          :placeholder="t('tvWorkbench.selectSymbol')"
          :loading="loadingWatchlist"
          @change="onAssetChange"
        >
          <a-select-option v-for="item in watchlistAssets" :key="item.key" :value="item.key">
            {{ item.label }}
          </a-select-option>
        </a-select>
        <a-radio-group v-model="timeframe" button-style="solid" size="small" @change="onTimeframeChange">
          <a-radio-button v-for="option in timeframes" :key="option" :value="option">{{ option }}</a-radio-button>
        </a-radio-group>
        <a-dropdown :trigger="['click']">
          <a-button size="small" icon="line-chart">
            {{ t('tvWorkbench.indicators') }}<span v-if="activeIndicators.length" class="indicator-count">{{ activeIndicators.length }}</span>
          </a-button>
          <div slot="overlay" class="indicator-overlay" @mousedown.stop @click.stop>
            <a-spin v-if="loadingIndicators" size="small" />
            <div v-else-if="!indicators.length" class="overlay-empty">{{ t('tvWorkbench.noIndicators') }}</div>
            <div v-else class="overlay-list">
              <label v-for="ind in indicators" :key="ind.id" class="overlay-row">
                <a-checkbox :checked="isActive(ind)" @change="event => toggleIndicator(ind, event.target.checked)" />
                <span class="overlay-name">{{ ind.name }}</span>
              </label>
            </div>
          </div>
        </a-dropdown>
        <a-button size="small" icon="save" :loading="saving" @click="openSaveTemplate">{{ t('tvWorkbench.saveTemplate') }}</a-button>
        <a-dropdown :trigger="['click']">
          <a-button size="small" icon="folder-open">{{ t('tvWorkbench.loadTemplate') }}</a-button>
          <div slot="overlay" class="indicator-overlay" @mousedown.stop @click.stop>
            <div v-if="!templates.length" class="overlay-empty">{{ t('tvWorkbench.noTemplates') }}</div>
            <div v-else class="overlay-list">
              <div v-for="template in templates" :key="template.id" class="overlay-row">
                <span class="overlay-name" @click="applyTemplate(template)">{{ template.name }}</span>
                <a-icon type="delete" class="overlay-delete" @click="removeTemplate(template)" />
              </div>
            </div>
          </div>
        </a-dropdown>
      </div>
    </header>

    <section class="workspace-card chart-card">
      <div class="chart-meta">
        <span class="chart-meta__symbol">{{ currentSymbol || t('tvWorkbench.selectSymbol') }}</span>
        <span v-if="currentMarket" class="chart-meta__market">{{ currentMarket }}</span>
        <span class="chart-meta__timeframe">{{ timeframe }}</span>
        <span v-if="indicatorError" class="chart-meta__warning">{{ indicatorError }}</span>
      </div>
      <div class="chart-body">
        <trading-view-chart
          v-if="currentSymbol"
          ref="chart"
          :key="chartKey"
          :market="currentMarket"
          :symbol="currentSymbol"
          :exchange-id="currentExchangeId"
          :market-type="currentMarketType"
          :instrument-id="currentInstrumentId"
          :timeframe="timeframe"
          :theme="isDarkTheme ? 'dark' : 'light'"
          :locale="locale"
          :indicators="activeIndicators"
          @indicator-error="onIndicatorError"
        />
        <div v-else class="chart-placeholder">{{ t('tvWorkbench.selectSymbol') }}</div>
      </div>
    </section>

    <a-modal
      v-model="saveModalVisible"
      :title="t('tvWorkbench.saveTemplate')"
      :confirm-loading="saving"
      @ok="saveTemplate"
    >
      <a-input v-model="templateName" :placeholder="t('tvWorkbench.templateName')" />
    </a-modal>
  </div>
</template>

<script>
import { mapState } from 'vuex'
import request from '@/utils/request'
import { getWatchlist } from '@/api/market'
import { getUserInfo } from '@/api/login'
import TradingViewChart from '@/components/TradingViewChart'

/**
 * Chart workspace on the TradingView library.
 *
 * The chart itself is a thin shell over `components/TradingViewChart`; what this
 * page owns is the part the library cannot know: which symbol the user watches,
 * which of *our* Python indicators should be drawn on top of it, and which
 * combination to remember.
 *
 * Indicators are saved as chart templates on the backend (`/api/users/chart-templates`),
 * so the same study set follows the user across browsers. The template stores
 * ids and params only -- the code and the computed series stay on the server.
 */
export default {
  name: 'TradingViewWorkbench',
  components: { TradingViewChart },
  data () {
    return {
      timeframes: ['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W'],
      timeframe: '1H',
      watchlistAssets: [],
      loadingWatchlist: false,
      // Resolved from the auth endpoint rather than the store: the store copy is
      // written at login and a token refresh will not repopulate it, which left
      // the watchlist request going out without a user id.
      userId: 0,
      selectedAssetKey: '',
      currentSymbol: '',
      currentMarket: '',
      currentExchangeId: '',
      currentMarketType: '',
      currentInstrumentId: '',
      indicators: [],
      loadingIndicators: false,
      activeIndicators: [],
      indicatorError: '',
      templates: [],
      saveModalVisible: false,
      templateName: '',
      saving: false,
      chartKey: 0
    }
  },
  computed: {
    ...mapState({ navTheme: state => state.app.theme, language: state => state.app.language }),
    isDarkTheme () { return ['dark', 'realdark'].includes(this.navTheme) },
    locale () {
      const value = String(this.language || 'zh-CN')
      return value.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    },
    currentAsset () {
      return this.watchlistAssets.find(item => item.key === this.selectedAssetKey) || null
    }
  },
  mounted () {
    this.bootstrap()
  },
  methods: {
    t (key) { return this.$t(key) },
    unwrap (res) { return res && Object.prototype.hasOwnProperty.call(res, 'data') ? res.data : res },

    async bootstrap () {
      await this.loadUserId()
      this.loadWatchlist()
      this.loadIndicators()
      this.loadTemplates()
    },

    async loadUserId () {
      try {
        const res = await getUserInfo()
        const info = this.unwrap(res)
        this.userId = Number(info?.id || info?.user_id || 0)
      } catch (_) {
        this.userId = 0
      }
    },

    async loadWatchlist () {
      this.loadingWatchlist = true
      try {
        const res = await getWatchlist({ userid: this.userId })
        const rows = this.unwrap(res)
        const list = Array.isArray(rows) ? rows : []
        this.watchlistAssets = list
          .filter(item => item && item.symbol)
          .map((item) => ({
            key: `${item.market || ''}|${item.symbol}|${item.exchange_id || ''}|${item.market_type || ''}|${item.instrument_id || ''}`,
            label: [item.symbol, item.market].filter(Boolean).join(' · '),
            market: item.market || '',
            symbol: item.symbol || '',
            exchangeId: item.exchange_id || '',
            marketType: item.market_type || '',
            instrumentId: item.instrument_id || ''
          }))
        if (!this.selectedAssetKey && this.watchlistAssets.length) {
          this.onAssetChange(this.watchlistAssets[0].key)
          this.selectedAssetKey = this.watchlistAssets[0].key
        }
      } catch (_) {
        // A failed watchlist leaves the picker empty; the user can still type a
        // symbol through the same select once it loads.
      } finally {
        this.loadingWatchlist = false
      }
    },

    async loadIndicators () {
      this.loadingIndicators = true
      try {
        const res = await request({ url: '/api/indicator/getIndicators', method: 'get', params: { userid: this.userId } })
        const rows = this.unwrap(res)
        this.indicators = (Array.isArray(rows) ? rows : []).filter(item => String(item.code || '').trim())
      } catch (_) {
        this.indicators = []
      } finally {
        this.loadingIndicators = false
      }
    },

    async loadTemplates () {
      try {
        const res = await request({ url: '/api/users/chart-templates', method: 'get' })
        const rows = this.unwrap(res)
        this.templates = Array.isArray(rows) ? rows : []
      } catch (_) {
        this.templates = []
      }
    },

    filterAsset (input, option) {
      if (!input) return true
      const needle = String(input).toLowerCase()
      return String(option.componentOptions?.children?.[0]?.text || '').toLowerCase().includes(needle)
    },

    onAssetChange (key) {
      const asset = this.watchlistAssets.find(item => item.key === key)
      if (!asset) return
      this.selectedAssetKey = key
      this.currentSymbol = asset.symbol
      this.currentMarket = asset.market
      this.currentExchangeId = asset.exchangeId
      this.currentMarketType = asset.marketType
      this.currentInstrumentId = asset.instrumentId
      // The series cache is keyed by symbol, so a change of symbol must rebuild
      // the studies; the chart component remounts for the same reason.
      this.activeIndicators = []
      this.indicatorError = ''
      this.chartKey += 1
    },

    onTimeframeChange () {
      this.activeIndicators = []
      this.indicatorError = ''
      this.chartKey += 1
    },

    isActive (indicator) {
      return this.activeIndicators.some(item => Number(item.indicatorId) === Number(indicator.id))
    },

    toggleIndicator (indicator, checked) {
      const indicatorId = Number(indicator.id)
      if (!indicatorId) return
      if (checked) {
        if (this.isActive(indicator)) return
        this.activeIndicators = [
          ...this.activeIndicators,
          { indicatorId, name: indicator.name || indicator.display_name || `Indicator ${indicatorId}` }
        ]
      } else {
        this.activeIndicators = this.activeIndicators.filter(item => Number(item.indicatorId) !== indicatorId)
      }
      this.indicatorError = ''
      // The chart reads its study list when it mounts, and the library has no
      // "add study to a live chart" call in the custom-study API, so the widget
      // is rebuilt with the new set.
      this.chartKey += 1
    },

    onIndicatorError (message) {
      this.indicatorError = message
    },

    openSaveTemplate () {
      this.templateName = this.templateName || `${this.currentSymbol} ${this.timeframe}`
      this.saveModalVisible = true
    },

    async saveTemplate () {
      const name = String(this.templateName || '').trim()
      if (!name) return
      this.saving = true
      try {
        await request({
          url: '/api/users/chart-templates',
          method: 'post',
          data: {
            name,
            template_id: '',
            // The backend keeps `id`, `instanceId`, `type`, `name` and `params`
            // and drops everything else, so the payload carries exactly those.
            // `instanceId` exists so one indicator can appear twice on a chart
            // with different settings; the id alone cannot express that.
            indicators: this.activeIndicators.map(item => ({
              id: String(item.indicatorId),
              instanceId: String(item.indicatorId),
              type: 'python',
              name: item.name || '',
              params: item.params || {},
              visible: true
            }))
          }
        })
        this.saveModalVisible = false
        await this.loadTemplates()
        this.$message.success(this.t('tvWorkbench.templateSaved'))
      } catch (err) {
        this.$message.error(err?.backendMessage || err?.message || this.t('tvWorkbench.templateSaveFailed'))
      } finally {
        this.saving = false
      }
    },

    applyTemplate (template) {
      const items = Array.isArray(template.indicators) ? template.indicators : []
      this.activeIndicators = items
        .map(item => ({
          indicatorId: Number(item.id || item.indicator_id || 0),
          name: item.name || '',
          params: item.params || {}
        }))
        .filter(item => item.indicatorId > 0)
      this.indicatorError = ''
      this.chartKey += 1
    },

    async removeTemplate (template) {
      const templateId = template.id || template.template_id
      if (!templateId) return
      try {
        await request({ url: '/api/users/chart-templates', method: 'delete', params: { template_id: templateId } })
        await this.loadTemplates()
      } catch (err) {
        this.$message.error(err?.message || this.t('tvWorkbench.templateSaveFailed'))
      }
    }
  }
}
</script>

<style lang="less" scoped>
.tv-workbench {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.page-header {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  align-items: flex-end;
  justify-content: space-between;
  padding: 16px 20px 8px;

  .kicker {
    display: block;
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    opacity: 0.6;
  }

  h1 {
    margin: 4px 0;
    font-size: 20px;
  }

  p {
    margin: 0;
    font-size: 13px;
    opacity: 0.7;
  }

  .header-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
  }

  .asset-select {
    min-width: 240px;
  }

  .indicator-count {
    display: inline-block;
    padding: 0 6px;
    margin-left: 6px;
    font-size: 11px;
    background: rgba(24, 144, 255, 0.18);
    border-radius: 8px;
  }
}

.workspace-card {
  flex: 1;
  min-height: 0;
  margin: 0 20px 20px;
  overflow: hidden;
  background: var(--qd-card-bg, #fff);
  border-radius: 8px;
}

.chart-card {
  display: flex;
  flex-direction: column;
  min-height: 520px;
}

.chart-meta {
  display: flex;
  gap: 12px;
  align-items: center;
  padding: 8px 12px;
  font-size: 12px;
  border-bottom: 1px solid rgba(128, 128, 128, 0.2);

  &__symbol {
    font-weight: 600;
  }

  &__market,
  &__timeframe {
    opacity: 0.65;
  }

  &__warning {
    margin-left: auto;
    color: #d48806;
  }
}

.chart-body {
  position: relative;
  flex: 1;
  min-height: 480px;
}

.chart-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 480px;
  font-size: 13px;
  opacity: 0.55;
}

.indicator-overlay {
  min-width: 240px;
  max-height: 320px;
  padding: 8px;
  overflow-y: auto;
  background: var(--qd-card-bg, #fff);
  border-radius: 6px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
}

.overlay-list {
  display: flex;
  flex-direction: column;
}

.overlay-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 4px 6px;
  border-radius: 4px;

  &:hover {
    background: rgba(24, 144, 255, 0.08);
  }
}

.overlay-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.overlay-delete {
  opacity: 0.5;

  &:hover {
    opacity: 1;
  }
}

.overlay-empty {
  padding: 12px;
  font-size: 12px;
  text-align: center;
  opacity: 0.6;
}
</style>
