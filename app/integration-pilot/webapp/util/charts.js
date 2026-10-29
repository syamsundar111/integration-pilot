sap.ui.define(['sap/ui/core/Lib'], (Lib) => {
  'use strict'

  /**
   * Column charts with SAP's Fiori chart library (sap.viz): themed like the rest of the app (light and
   * dark), with a tooltip per column. The library is large, so it is loaded only when a page first
   * needs a chart, not with the app.
   */
  let loading
  const load = () =>
    (loading ??= Lib.load({ name: 'sap.viz' }).then(
      () =>
        new Promise((resolve, reject) =>
          sap.ui.require(
            ['sap/viz/ui5/controls/VizFrame', 'sap/viz/ui5/data/FlattenedDataset', 'sap/viz/ui5/controls/common/feeds/FeedItem', 'sap/viz/ui5/controls/VizTooltip'],
            (VizFrame, FlattenedDataset, FeedItem, VizTooltip) => resolve({ VizFrame, FlattenedDataset, FeedItem, VizTooltip }),
            reject
          )
        )
    ))

  /**
   * A column chart in `container` (e.g. an empty VBox), bound to an array in a JSON model.
   * @param {object} container - control with an `items` aggregation
   * @param {{ model: string, path: string, dimension: { name: string, value: string },
   *   measures: { name: string, value: string }[], stacked?: boolean, time?: boolean, colors?: string[], height?: string }} c
   *   value: a binding path relative to one row, e.g. "label"; colors: CSS colors or theme parameter names;
   *   time: the dimension is a date (one column per day on a time axis that always fits the width)
   */
  async function column(container, c) {
    const { VizFrame, FlattenedDataset, FeedItem, VizTooltip } = await load()
    const b = (p) => `{${c.model}>${p}}`
    const type = c.stacked ? 'stacked_column' : 'column'
    const chart = new VizFrame({
      vizType: c.time ? `timeseries_${type}` : type,
      width: '100%',
      height: c.height || '16rem',
      uiConfig: { applicationSet: 'fiori' },
      dataset: new FlattenedDataset({
        dimensions: [{ name: c.dimension.name, value: b(c.dimension.value), ...(c.time && { dataType: 'date' }) }],
        measures: c.measures.map((m) => ({ name: m.name, value: b(m.value) })),
        data: { path: `${c.model}>${c.path}` }
      }),
      feeds: [
        new FeedItem({ uid: 'valueAxis', type: 'Measure', values: c.measures.map((m) => m.name) }),
        new FeedItem({ uid: c.time ? 'timeAxis' : 'categoryAxis', type: 'Dimension', values: [c.dimension.name] })
      ],
      vizProperties: {
        title: { visible: false },
        legend: { visible: c.measures.length > 1 },
        legendGroup: { layout: { position: 'bottom' } },
        // all columns fit the width: no scrollbar, a long period gives thinner columns
        plotArea: { dataLabel: { visible: false }, drawingEffect: 'normal', dataPointSize: { min: 2, max: 64 }, ...(c.colors && { colorPalette: c.colors }) },
        valueAxis: { title: { visible: false } },
        // slanted labels (model and action names) may use up to 40 % of the chart height before they get "…"
        categoryAxis: { title: { visible: false }, layout: { maxHeight: 0.4 } },
        timeAxis: { title: { visible: false }, levels: ['day', 'month'] },
        interaction: { selectability: { mode: 'NONE' } }
      }
    })
    container.removeAllItems()
    container.addItem(chart)
    new VizTooltip({}).connect(chart.getVizUid())
    return chart
  }

  return { column, load }
})
