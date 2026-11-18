import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { evictKeepAliveEntry, routeCacheKey, versionedRouteCacheKey } from '../../src/components/MultiTab/cacheControl.mjs'
import { tabKey } from '../../src/components/MultiTab/tabIdentity.mjs'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')

test('route view keeps cache storage mounted across cached and non-cached pages', () => {
  const routeView = read('src/layouts/RouteView.vue')
  const layout = read('src/layouts/BasicLayout.vue')

  assert.match(layout, /<route-view[^>]+:keep-alive="multiTab"/)
  assert.match(routeView, /<keep-alive[^>]*:max="maxCachedPages">/)
  assert.match(routeView, /v-if="shouldKeepAlive"/)
  assert.match(routeView, /v-if="!shouldKeepAlive"/)
  assert.match(routeView, /routeMeta\.keepAlive/)
  assert.match(routeView, /cachedRouteBaseKey/)
  assert.match(routeView, /versionedRouteCacheKey/)
  assert.match(routeView, /this\.\$route\.fullPath \|\| this\.\$route\.path/)
  assert.doesNotMatch(routeView, /return <router-view key=\{routeKey\}/)
})

test('closing a multi-tab page destroys only its matching keep-alive entry', () => {
  const routeView = read('src/layouts/RouteView.vue')
  const multiTab = read('src/components/MultiTab/MultiTab.vue')
  let destroyed = 0
  const keepAlive = {
    cache: {
      'IndicatorIDE::0': { componentInstance: { _isDestroyed: false, $destroy: () => { destroyed += 1 } } },
      StrategyCenter: { componentInstance: { _isDestroyed: false, $destroy: () => { destroyed += 10 } } }
    },
    keys: ['IndicatorIDE::0', 'StrategyCenter']
  }

  assert.equal(routeCacheKey({ name: 'IndicatorIDE', path: '/indicator-ide' }), 'IndicatorIDE')
  assert.equal(versionedRouteCacheKey({ name: 'IndicatorIDE' }), 'IndicatorIDE::0')
  assert.equal(versionedRouteCacheKey('IndicatorIDE', 2), 'IndicatorIDE::2')
  assert.equal(evictKeepAliveEntry(keepAlive, 'IndicatorIDE::0'), true)
  assert.equal(destroyed, 1)
  assert.equal(keepAlive.cache['IndicatorIDE::0'], null)
  assert.deepEqual(keepAlive.keys, ['StrategyCenter'])
  assert.ok(keepAlive.cache.StrategyCenter)
  assert.match(multiTab, /events\.\$emit\('cache-evict', targetPage\)/)
  assert.match(routeView, /pendingCacheEvictions/)
  assert.match(routeView, /routeCacheVersions/)
  assert.match(routeView, /this\.\$set\(this\.routeCacheVersions/)
  assert.match(routeView, /this\.\$nextTick\(this\.flushPendingCacheEvictions\)/)
})

test('closing indicator workspace stops the autosave instead of writing page state', () => {
  const indicatorIde = read('src/views/indicator-ide/index.vue')

  assert.match(indicatorIde, /multiTabEvents\.\$on\('cache-evict', this\.handleTabCacheEviction\)/)
  assert.match(indicatorIde, /handleTabCacheEviction \(route\) \{[\s\S]*?this\.clearWorkspaceAutosave\(\)/)
  // Page state now lives in the workspace archive, not in per-page keys. The
  // legacy keys are only deleted once, when the archive adopts them.
  assert.doesNotMatch(indicatorIde, /persistIdeUiState/)
  assert.match(indicatorIde, /clearLegacyWorkspaceKeys \(\) \{[\s\S]*?storage\.remove\(ideUiCacheStorageKey\(this\.userId\)\)/)
  assert.match(indicatorIde, /clearLegacyWorkspaceKeys \(\) \{[\s\S]*?storage\.remove\(ideSelectionStorageKey\(this\.userId\)\)/)
})

test('multi-tab workspaces are enabled for users without a saved preference', () => {
  const defaults = read('src/config/defaultSettings.js')
  const bootstrap = read('src/core/bootstrap.js')

  assert.match(defaults, /multiTab:\s*true/)
  assert.match(bootstrap, /storage\.get\(TOGGLE_MULTI_TAB, defaultSettings\.multiTab\)/)
})

test('cached IDE pages release global save shortcuts while hidden', () => {
  const strategyIde = read('src/views/strategy-ide/index.vue')
  const indicatorIde = read('src/views/indicator-ide/index.vue')

  assert.match(strategyIde, /deactivated \(\)[\s\S]*removeEventListener\('keydown', this\._saveShortcut, true\)/)
  assert.match(strategyIde, /activated \(\)[\s\S]*addEventListener\('keydown', this\._saveShortcut, true\)/)
  assert.match(indicatorIde, /deactivated \(\)[\s\S]*removeEventListener\('keydown', this\._saveShortcutListener\)/)
  assert.match(indicatorIde, /activated \(\)[\s\S]*addEventListener\('keydown', this\._saveShortcutListener\)/)
})

test('workspace tabs are identified by route path instead of transient query state', () => {
  assert.equal(tabKey('/strategy-ide'), '/strategy-ide')
  assert.equal(tabKey('/strategy-ide?tab=script&sourceId=26'), '/strategy-ide')
  assert.equal(tabKey({
    path: '/strategy-ide',
    fullPath: '/strategy-ide?tab=script&draft=1',
    meta: {}
  }), '/strategy-ide')
})

test('routes can explicitly opt into separate query-specific tabs', () => {
  assert.equal(tabKey({
    path: '/research',
    fullPath: '/research?run=two',
    meta: { multiTabByFullPath: true }
  }), '/research?run=two')
})
