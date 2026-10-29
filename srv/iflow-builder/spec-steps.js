/**
 * The steps of a spec with their paths: the main flow in order, a router's route steps right after the
 * router, then the exception subprocess. Routers sit on the main line only (no routers inside routes).
 */

/**
 * @returns {{ step: object, where: string, ptr: string, router?: object, route?: object, routeIndex?: number }[]}
 *   where: "steps[2].routes[1].steps[0]" (messages), ptr: "/steps/2/routes/1/steps/0" (schema paths)
 */
function mainSteps(spec) {
  const out = []
  ;(Array.isArray(spec?.steps) ? spec.steps : []).forEach((step, i) => {
    out.push({ step, where: `steps[${i}]`, ptr: `/steps/${i}` })
    if (step?.type !== 'router' || !Array.isArray(step.routes)) return
    step.routes.forEach((route, j) =>
      (Array.isArray(route?.steps) ? route.steps : []).forEach((s, k) =>
        out.push({ step: s, where: `steps[${i}].routes[${j}].steps[${k}]`, ptr: `/steps/${i}/routes/${j}/steps/${k}`, router: step, route, routeIndex: j })
      )
    )
  })
  return out
}

/** Steps of the exception subprocess with their paths */
function exceptionSteps(spec) {
  const list = Array.isArray(spec?.exceptionSubprocess?.steps) ? spec.exceptionSubprocess.steps : []
  return list.map((step, i) => ({ step, where: `exceptionSubprocess.steps[${i}]`, ptr: `/exceptionSubprocess/steps/${i}` }))
}

/** Every step: main flow (with route steps) and exception subprocess */
const allSteps = (spec) => [...mainSteps(spec), ...exceptionSteps(spec)]

/** The value at a message path like "steps[2].routes[1].steps[0].properties[3].value" */
function valueAt(spec, path) {
  let v = spec
  for (const part of path.match(/[^.[\]]+/g) || []) v = v == null ? undefined : v[/^\d+$/.test(part) ? Number(part) : part]
  return v
}

module.exports = { mainSteps, exceptionSteps, allSteps, valueAt }
