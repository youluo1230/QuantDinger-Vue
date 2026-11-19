import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const source = readFileSync(new URL('../../src/views/indicator-ide/index.vue', import.meta.url), 'utf8')

test('the notification dialog lets the operator pick the indicator', () => {
  assert.match(source, /v-model="signalAlertForm\.indicatorId"/)
  assert.match(source, /signalAlertIndicatorOptions \(\) \{/)
  assert.match(source, /@change="onSignalAlertIndicatorChange"/)
})

test('the alert payload follows the picked indicator, not the editor selection', () => {
  assert.match(source, /indicator_id: ind \? Number\(ind\.id\) : this\.selectedIndicatorId/)
  assert.match(source, /indicator_name: ind \? this\.indicatorDisplayName\(ind\)/)
  assert.match(source, /signalAlertSignalOptions \(\) \{\s*return this\.extractSignalAlertOptions\(this\.signalAlertIndicatorCode/)
})
