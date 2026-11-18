/**
 * Pine execution in the browser.
 *
 * The point of running the script here is that the chart can then draw what the
 * author is looking at, with no round trip and no bar cap. Three things have to
 * hold for that to be safe, and they are what this file pins:
 *
 * 1. the bars handed to the runtime are the chart's bars, in the unit the
 *    runtime requires -- a study computed against a shifted series draws a
 *    plausible line in the wrong place;
 * 2. Pine's own plot metadata reaches the study, because `overlay` decides
 *    whether the output lands on the price pane or its own;
 * 3. a script that draws nothing must not add an empty legend entry, and the
 *    drawing collections the study contract cannot express are dropped rather
 *    than rendered as a line of nulls.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_STUDY_BARS,
  DEFAULT_STUDY_BARS,
  labelsFromPine,
  plotsFromPine,
  readPineInputs,
  runPineStudy,
  tablesFromPine,
  toBarTimeMs,
  toInputSpecs,
  toPineBar
} from '../../src/charting/pineRuntime.js'

describe('toBarTimeMs', () => {
  it('reads seconds as seconds and milliseconds as milliseconds', () => {
    // The venue APIs answer in seconds; the library and PineTS speak
    // milliseconds. 1e11 separates them: seconds that large is the year 5138,
    // milliseconds that large is 1973.
    assert.equal(toBarTimeMs(1700000000), 1700000000000)
    assert.equal(toBarTimeMs(1700000000000), 1700000000000)
  })

  it('rejects values that cannot be a time', () => {
    assert.equal(toBarTimeMs(null), null)
    assert.equal(toBarTimeMs(''), null)
    assert.equal(toBarTimeMs('abc'), null)
    assert.equal(toBarTimeMs(0), null)
    assert.equal(toBarTimeMs(-5), null)
  })
})

describe('toPineBar', () => {
  it('normalises a venue candle to a Pine bar', () => {
    const bar = toPineBar({
      time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10
    })
    assert.equal(bar.time, 1700000000000)
    assert.equal(bar.close, 1.5)
  })

  it('drops a row a runtime could not use', () => {
    // A missing close would turn every arithmetic result downstream into NaN,
    // so the bar is removed rather than passed on.
    assert.equal(toPineBar({ time: 1700000000, open: 1, high: 2, low: 0.5 }), null)
    assert.equal(toPineBar({ open: 1, high: 2, low: 0.5, close: 1 }), null)
  })

  it('defaults volume to zero rather than dropping the bar', () => {
    // Some venues omit volume on index symbols; the bar is still drawable.
    const bar = toPineBar({ time: 1700000000, open: 1, high: 2, low: 0.5, close: 1.5 })
    assert.equal(bar.volume, 0)
  })
})

describe('plotsFromPine', () => {
  it('turns a PineTS plot into a drawable series', () => {
    const out = plotsFromPine({
      EMA: {
        title: 'EMA',
        options: { color: '#2962ff', overlay: true },
        data: [{ value: 1 }, { value: 2 }, { value: null }]
      }
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'EMA')
    assert.equal(out[0].overlay, true)
    assert.deepEqual(out[0].data, [1, 2, null])
  })

  it('keeps per-bar colours, which are the author\'s signal', () => {
    // A regime ribbon coloured per bar flattens into a different study if the
    // colours are dropped; the point shape is the only thing that says "cross".
    const out = plotsFromPine({
      Trend: {
        title: 'Trend',
        data: [
          { value: 1, options: { color: '#22C55E' } },
          { value: 2, options: { color: '#EF4444' } }
        ]
      }
    })
    assert.deepEqual(out[0].data, [
      { value: 1, color: '#22C55E' },
      { value: 2, color: '#EF4444' }
    ])
  })

  it('keeps a series the author sent to the data window, out of the pane', () => {
    // `display.data_window` is a count meant for inspection, not a drawing:
    // Pine leaves the pane alone and shows the number in the data window. These
    // scripts use it 161 times, so painting them adds lines nobody asked for --
    // but the series still has to exist, because `fill` reads it by title.
    const out = plotsFromPine({
      Count: {
        title: 'Count',
        options: { display: 'data_window' },
        data: [{ value: 1 }, { value: 2 }]
      },
      Status: {
        title: 'Status',
        options: { display: 'status_line' },
        data: [{ value: 3 }]
      },
      Hidden: {
        title: 'Hidden',
        options: { display: 'none' },
        data: [{ value: 4 }]
      },
      Drawn: {
        title: 'Drawn',
        options: { display: 'pane' },
        data: [{ value: 5 }]
      }
    })
    assert.deepEqual(out.map(plot => [plot.name, plot.hidden === true]), [
      ['Count', true],
      ['Status', true],
      ['Hidden', true],
      ['Drawn', false]
    ])
  })

  it('drops the drawing collections the study contract cannot express', () => {
    const out = plotsFromPine({
      __labels__: { data: [{ value: 1 }] },
      __tables__: { data: [{ value: 1 }] },
      EMA: { title: 'EMA', data: [{ value: 1 }] }
    })
    assert.deepEqual(out.map(plot => plot.name), ['EMA'])
  })

  it('drops colour-only plots, which have no line to draw', () => {
    // `bgcolor`/`barcolor` arrive as pseudo-plots; drawing them as lines would
    // put a flat series in the legend that the author never plotted.
    const out = plotsFromPine({
      'bgcolor#0': { data: [{ value: null }], options: { style: 'background' } },
      'barcolor#0': { data: [{ value: null }] },
      EMA: { title: 'EMA', data: [{ value: 1 }] }
    })
    assert.deepEqual(out.map(plot => plot.name), ['EMA'])
  })

  it('drops a series with no value at all', () => {
    const out = plotsFromPine({
      Empty: { title: 'Empty', data: [{ value: null }, { value: null }] }
    })
    assert.deepEqual(out, [])
  })

  it('keeps the drawing kind of a marker so the chart can draw a shape', () => {
    // A script that only marks signals has no numeric series at all. Treating
    // "no numbers" as "nothing to draw" is what made it look broken.
    const out = plotsFromPine({
      Up: {
        title: 'Up',
        options: { style: 'shape', location: 'BelowBar', shape: 'shape_triangle_up', text: 'BUY', color: '#00e676', overlay: true },
        data: [{ value: false }, { value: true }, { value: false }]
      }
    })
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'shape')
    assert.equal(out[0].name, 'Up')
    assert.equal(out[0].shape, 'shape_triangle_up')
    assert.equal(out[0].location, 'BelowBar')
    // A marker is drawn on the bars it fires on and nowhere else.
    assert.deepEqual(out[0].data, [null, 1, null])
  })

  it('keeps a character marker distinct from a shape', () => {
    const out = plotsFromPine({
      Dn: {
        title: 'Dn',
        options: { style: 'char', char: 'X', location: 'AboveBar' },
        data: [{ value: true }]
      }
    })
    assert.equal(out[0].kind, 'char')
    assert.equal(out[0].char, 'X')
    assert.deepEqual(out[0].data, [1])
  })

  it('keeps all four prices of a candle plot', () => {
    // Reading the last number of a candle as a line throws away open, high and
    // low -- a different drawing with the same name.
    const out = plotsFromPine({
      Candles: {
        title: 'Candles',
        options: { style: 'candle', color: '#4CAF50', overlay: true },
        data: [{ value: [10, 12, 9, 11] }, { value: null }]
      }
    })
    assert.equal(out[0].kind, 'candle')
    assert.deepEqual(out[0].data, [{ open: 10, high: 12, low: 9, close: 11 }, null])
  })

  it('carries the per-bar colours of a barcolor call', () => {
    const out = plotsFromPine({
      'barcolor#0': {
        options: { style: 'barcolor' },
        data: [{ value: true, options: { color: '#2962FF' } }, { value: null }]
      }
    })
    assert.equal(out[0].kind, 'barcolor')
    assert.deepEqual(out[0].colors, ['#2962FF', null])
  })

  it('names the second background separately from the first', () => {
    // Both arrive as `bgcolor#N` with no title; two identical legend rows for
    // two different drawings would be unusable.
    const out = plotsFromPine({
      'bgcolor#0': { options: { style: 'background' }, data: [{ value: true, options: { color: '#11111133' } }] },
      'bgcolor#1': { options: { style: 'background' }, data: [{ value: true, options: { color: '#22222233' } }] }
    })
    assert.deepEqual(out.map(plot => plot.name), ['Background', 'Background 2'])
  })

  it('turns a fill into the two plots it shades', () => {
    const out = plotsFromPine({
      A: { title: 'A', data: [{ value: 1 }] },
      B: { title: 'B', data: [{ value: 2 }] },
      fill: { options: { plot1: 'A', plot2: 'B', color: '#2962FF33', style: 'fill' }, data: [{ value: null }] }
    })
    const fill = out.find(plot => plot.kind === 'fill')
    assert.equal(fill.plot1, 'A')
    assert.equal(fill.plot2, 'B')
  })

  it('reads a styled plot as the style it asks for', () => {
    // A histogram and a stepline are the same numbers drawn as different
    // studies; flattening them all to a line loses the drawing.
    const out = plotsFromPine({
      Hist: { title: 'Hist', options: { style: 'style_histogram' }, data: [{ value: 1 }] },
      Step: { title: 'Step', options: { style: 'style_stepline' }, data: [{ value: 1 }] },
      Circles: { title: 'Circles', options: { style: 'style_circles' }, data: [{ value: 1 }] }
    })
    assert.deepEqual(out.map(plot => plot.style.plottype), [1, 9, 6])
  })

  it('keeps a marker plot that never fires, so the study still loads', () => {
    // PineTS emits a row per bar whether or not the condition held. Dropping an
    // all-false marker would take the whole study off the chart and make a
    // working script look like one that failed.
    const out = plotsFromPine({
      Never: { title: 'Never', options: { style: 'shape', shape: 'shape_circle' }, data: [{ value: false }, { value: false }] }
    })
    assert.equal(out.length, 1)
    assert.deepEqual(out[0].data, [null, null])
  })

  it('reads overlay from the script so the pane choice is the author\'s', () => {
    const out = plotsFromPine({
      A: { title: 'A', options: { overlay: true }, data: [{ value: 1 }] },
      B: { title: 'B', options: { overlay: false }, data: [{ value: 1 }] }
    })
    assert.deepEqual(out.map(plot => plot.overlay), [true, false])
  })
})

describe('scripts that import a library', () => {
  const bars = () => [0, 1].map(i => ({
    time: 1700000000000 + i * 3600000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 + i
  }))

  it('resolves TradingView/ta so the script runs instead of erroring', async () => {
    // Without a resolver this exact script fails with "The script imports
    // \"TradingView/ta/12\" but no import resolver is configured", which is an
    // error about our plumbing, not about the author's code.
    const out = await runPineStudy({
      code: '//@version=6\nindicator("delta")\nimport TradingView/ta/12 as taLib\n[a, b, c, d] = taLib.requestVolumeDelta("60")\nplot(d, "delta")',
      bars: bars(),
      timeframe: '1h',
      interval: '60'
    })
    assert.equal(out.plots.length, 1)
    assert.equal(out.plots[0].name, 'delta')
    // A bar that closed above its open is all buying: 10 of volume, no selling.
    const values = out.plots[0].data.map(entry => (entry && typeof entry === 'object' ? entry.value : entry))
    assert.deepEqual(values, [10, 11])
  })

  it('runs a script against a stand-in library instead of refusing it', async () => {
    // The facade that would serve the real source is unreachable, so the members
    // the script names are stubbed with `na`. The study draws; the parts leaning
    // on the library come out blank rather than as a wrong number.
    const out = await runPineStudy({
      code: '//@version=6\nindicator("z")\nimport Trendoscope/ZigzagLite/4 as zg\nvar zg.Zigzag zz = zg.Zigzag.new()\nplot(close)',
      bars: bars(),
      timeframe: '1h',
      interval: '60'
    })
    assert.equal(out.plots.length, 1)
  })

  it('runs a script with no import without asking the resolver', async () => {
    // The resolver is installed only when the source imports something, so a
    // plain script must still work after the import path was added.
    const out = await runPineStudy({
      code: '//@version=6\nindicator("plain")\nplot(close)',
      bars: bars(),
      timeframe: '1h',
      interval: '60'
    })
    assert.equal(out.plots.length, 1)
  })
})

describe('study budget', () => {
  it('caps a runaway bar count', () => {
    assert.ok(MAX_STUDY_BARS > DEFAULT_STUDY_BARS)
    assert.ok(DEFAULT_STUDY_BARS > 360, 'the old backend cap must not survive here')
  })

  it('asks for no more bars than a script can need', () => {
    // Every bar a study asks for is memory and time spent drawing a line the
    // user cannot see. A scan of all 238 stored scripts found the longest
    // hard-coded warmup is 250 (an EMA length), so 600 is already more than
    // twice the worst case -- and twice the chart's own viewport. Pinned here
    // so a future "just make it bigger" does not go unnoticed: the escalating
    // value was 1500, which was three times what the corpus needs.
    assert.ok(DEFAULT_STUDY_BARS <= 600, `study budget grew to ${DEFAULT_STUDY_BARS}`)
  })
})

describe('Pine input declarations', () => {
  // The parameter panel used to read `# @param` comments, which a Pine script
  // does not have. These assert that the panel's data now comes from the
  // declarations the runtime will actually honour.
  it('reads the settings a real script declares', async () => {
    const specs = await readPineInputs({
      code: `//@version=6
indicator("T", overlay=true)
len = input.int(14, "Lookback", minval=1, maxval=200, group="Params", tooltip="Bars to average")
`
    })
    const lookback = specs.find(spec => spec.name === 'Lookback')
    assert.ok(lookback, 'the declared title is the key')
    assert.equal(lookback.type, 'int')
    assert.equal(lookback.defaultValue, 14)
    assert.equal(lookback.group, 'Params')
    assert.equal(lookback.description, 'Bars to average')
    assert.equal(lookback.min, 1)
    assert.equal(lookback.max, 200)
    // The override keys the runtime accepts, kept so a saved value can be
    // applied the way the script names it.
    assert.equal(lookback.pineInputId, 'in_0')
    assert.equal(lookback.pineVarId, 'len')
  })

  it('carries the allowed values of a string input', () => {
    const specs = toInputSpecs([{
      id: 'in_0',
      name: 'Mode',
      title: 'Mode',
      type: 'string',
      defval: 'fast',
      options: ['fast', 'slow']
    }])
    assert.deepEqual(specs[0].values, ['fast', 'slow'])
  })

  it('maps a bool to a boolean default rather than the string "false"', () => {
    const specs = toInputSpecs([{ id: 'in_0', title: 'Show', type: 'bool', defval: false }])
    assert.equal(specs[0].defaultValue, false)
    assert.equal(specs[0].type, 'bool')
  })

  it('returns nothing for a script that does not compile yet', async () => {
    // The author is mid-keystroke; an empty panel is a better answer than an
    // exception escaping into the editor.
    assert.deepEqual(await readPineInputs({ code: 'indicator("x"\nplot(close' }), [])
  })

  it('returns nothing for blank source', async () => {
    assert.deepEqual(await readPineInputs({ code: '   ' }), [])
  })

  it('changes the study when a declared input is overridden', async () => {
    // This is the property that makes the parameter panel worth having: an
    // override must reach the calculation, not just the form.
    const code = `//@version=6
indicator("S")
len = input.int(3, "Length", minval=1)
plot(ta.sma(close, len))
`
    const bars = Array.from({ length: 120 }, (_unused, index) => ({
      time: 1700000000000 + index * 3600000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100 + index,
      volume: 1000
    }))
    const lastFor = async (params) => {
      const out = await runPineStudy({ code, bars, params })
      const series = out.plots[0].data
      return series[series.length - 1]?.value ?? series[series.length - 1]
    }
    const short = await lastFor({ Length: 3 })
    const long = await lastFor({ Length: 50 })
    assert.notEqual(short, long, 'a longer average must not produce the same value')
  })

  it('keeps running when an override names an input the script lost', async () => {
    // A saved value outlives the input it was saved for. Dropping it silently
    // beats refusing to draw the study.
    const code = '//@version=6\nindicator("S")\nplot(close)\n'
    const bars = [{ time: 1700000000000, open: 1, high: 2, low: 1, close: 1.5, volume: 1 }]
    const out = await runPineStudy({ code, bars, params: { Gone: 7 } })
    assert.equal(out.plots.length, 1)
  })

  it('applies an override whose title was trimmed for display', async () => {
    // A declaration may pad its title (`input.int(14, "  Padded  ")`). The IDE
    // trims what it shows in the form, and the runtime keys overrides by the
    // exact title, so the trimmed key has to be resolved back to the input id
    // or the author's change silently would not take effect.
    const code = [
      '//@version=6',
      'indicator("padded")',
      'a = input.int(10, "  Padded  ")',
      'b = input.int(20, "Plain")',
      'plot(a + b)'
    ].join('\n')
    const bars = Array.from({ length: 40 }, (_unused, index) => ({
      time: 1700000000000 + index * 3600000,
      open: 100 + index,
      high: 101 + index,
      low: 99 + index,
      close: 100.5 + index,
      volume: 10
    }))
    const plain = await runPineStudy({ code, bars, symbol: 'BTC/USDT', timeframe: '1h' })
    const overridden = await runPineStudy({
      code,
      bars,
      symbol: 'BTC/USDT',
      timeframe: '1h',
      params: { Padded: 99 }
    })
    const lastValue = (result) => {
      const series = Object.values(result.plots)[0]
      const values = series?.values || series?.data || []
      return Number(values.at(-1)?.value ?? values.at(-1))
    }
    // 99 instead of 10 must show up in a + b, so the difference is 89.
    assert.ok(
      Math.abs((lastValue(overridden) - lastValue(plain)) - 89) < 1e-6,
      `expected the trimmed title to apply, got ${lastValue(plain)} -> ${lastValue(overridden)}`
    )
  })
})

describe('a script that imports a library this build does not bundle', () => {
  // These scripts are why the corpus sweep reported failures that looked like
  // our bug: the runtime threw from the transpiler before the run, quoting the
  // resolver's contract. The study still cannot draw, but the message has to say
  // which library is missing.
  const BARE_IMPORT = '//@version=6\nindicator("z")\nimport Trendoscope/ZigzagLite/4 as zg\nlen = input.int(5, "Length")\nplot(close)'

  it('still lists the inputs when only the imports are unresolved', async () => {
    // Transpiling needs each import to parse, not for its functions to exist, so
    // a stub is enough here. Without that the panel showed nothing at all for a
    // script whose inputs the author can still usefully edit.
    const specs = await readPineInputs({ code: BARE_IMPORT })
    assert.equal(specs.length, 1)
    assert.equal(specs[0].name, 'Length')
  })

  it('keeps working for a script whose library IS vendored', async () => {
    const specs = await readPineInputs({
      code: '//@version=6\nindicator("v")\nimport TradingView/ta/12 as taLib\nlen = input.int(7, "Length")\nplot(close)'
    })
    assert.equal(specs.length, 1)
    assert.equal(specs[0].name, 'Length')
    assert.equal(specs[0].type, 'int')
  })

  it('is reported per study, so the rest of the chart still draws', async () => {
    // One failure must not take the pane down: the chart resolves each study
    // independently and reports the ones that could not run.
    const rows = [{ time: 1700000000000, open: 1, high: 2, low: 1, close: 1.5, volume: 1 }]
    const out = await runPineStudy({
      code: '//@version=6\nindicator("ok")\nplot(close)',
      bars: rows,
      timeframe: '1h',
      interval: '60'
    })
    assert.equal(out.plots.length, 1)
    // A script that calls a stub function still draws.
    const stubbed = await runPineStudy({ code: BARE_IMPORT, bars: rows, timeframe: '1h', interval: '60' })
    assert.equal(stubbed.plots.length, 1)
  })
})

describe('the drawings a script makes instead of plotting', () => {
  // 60 of the stored scripts draw labels and 77 draw tables; 7 draw nothing
  // else at all. Reading them out of the runtime is what stops those studies
  // from being registered and then drawing a blank pane.
  it('reads a label as the time, price and text it draws', () => {
    const context = {
      _drawingHelpers: {
        0: {
          _labels: [
            { x: 7, y: 101.5, text: 'BUY', tooltip: '', color: '#00FF00', textcolor: '#FFFFFF', style: 'style_label_up', size: 'small', _deleted: false }
          ]
        }
      }
    }
    assert.deepEqual(labelsFromPine(context), [
      { barIndex: 7, price: 101.5, text: 'BUY', tooltip: '', color: '#00FF00', textColor: '#FFFFFF', style: 'style_label_up', size: 'small', boxed: true }
    ])
  })

  it('finds the collections without trusting what index they sit at', () => {
    // The runtime's index numbering is an implementation detail; a version that
    // renumbers it must not silently empty every label on the chart.
    const context = { _drawingHelpers: { 9: { _labels: [{ x: 1, y: 2, text: 'hi' }] } } }
    assert.equal(labelsFromPine(context).length, 1)
  })

  it('drops a deleted label and one with nothing to draw', () => {
    const context = {
      _drawingHelpers: {
        0: {
          _labels: [
            { x: 1, y: 2, text: 'gone', _deleted: true },
            { x: 3, y: 4, text: '', tooltip: '' }
          ]
        }
      }
    }
    assert.deepEqual(labelsFromPine(context), [])
  })

  it('keeps a tooltip-only label but marks it as unboxed', () => {
    const context = { _drawingHelpers: { 0: { _labels: [{ x: 2, y: 3, text: '', tooltip: 'detail', style: 'style_none' }] } } }
    const [label] = labelsFromPine(context)
    assert.equal(label.tooltip, 'detail')
    assert.equal(label.boxed, false)
  })

  it('reads a table as positioned cells, skipping the holes in the grid', () => {
    const context = {
      _drawingHelpers: {
        5: {
          _tables: [{
            position: 'bottom_left',
            columns: 2,
            rows: 2,
            bgcolor: '#101010',
            border_color: '#404040',
            frame_color: '',
            _deleted: false,
            cells: [
              [{ text: 'A', text_color: '#FFF', bgcolor: '#F00', text_size: 'small', tooltip: '' }, null],
              [null, { text: 'D', text_color: '#000', bgcolor: '', text_size: 'normal', tooltip: 'hover' }]
            ]
          }]
        }
      }
    }
    const [table] = tablesFromPine(context)
    assert.equal(table.position, 'bottom_left')
    assert.equal(table.backgroundColor, '#101010')
    assert.deepEqual(table.cells.map(cell => [cell.row, cell.column, cell.text]), [[0, 0, 'A'], [1, 1, 'D']])
    assert.equal(table.cells[1].tooltip, 'hover')
  })

  it('has no table to draw when every cell is empty', () => {
    const context = { _drawingHelpers: { 5: { _tables: [{ position: 'top_right', cells: [[null, { text: '' }]] }] } } }
    assert.deepEqual(tablesFromPine(context), [])
  })

  it('has no drawings to read when the context carries none', () => {
    assert.deepEqual(labelsFromPine(undefined), [])
    assert.deepEqual(tablesFromPine({}), [])
    assert.deepEqual(tablesFromPine({ _drawingHelpers: {} }), [])
  })

  it('draws a table-only script, which has no plots at all', async () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({
      openTime: 1700000000000 + index * 3600000,
      closeTime: 1700000000000 + (index + 1) * 3600000,
      open: 100 + index,
high: 101 + index,
low: 99 + index,
close: 100.5 + index,
volume: 10
    }))
    const out = await runPineStudy({
      code: [
        '//@version=6',
        'indicator("table only")',
        'var table t = table.new(position.top_right, 1, 1)',
        'if barstate.islast',
        '    table.cell(t, 0, 0, "ONLY OUTPUT")',
        '    label.new(bar_index, high, "and a label")'
      ].join('\n'),
      bars: rows,
      timeframe: '1h',
      interval: '60'
    })
    assert.equal(out.plots.length, 0)
    assert.equal(out.tables.length, 1)
    assert.equal(out.tables[0].cells[0].text, 'ONLY OUTPUT')
    assert.equal(out.labels.length, 1)
    assert.equal(out.labels[0].text, 'and a label')
  })
})
