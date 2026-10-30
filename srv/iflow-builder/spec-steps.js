/**
 * The steps of a spec with their paths: the main flow in order, a router's route steps right after the
 * router and a multicast's branch steps right after the multicast, then the exception subprocess, then the
 * local processes (with their routers' route steps). Routers sit on the main line, a multicast branch or the
 * line of a local process (no routers inside routes); splitters and gathers on the main line or a branch;
 * multicasts on the main line only.
 */

/**
 * @returns {{ step: object, where: string, ptr: string, router?: object, route?: object, routeIndex?: number, multicast?: object, branch?: object, branchIndex?: number }[]}
 *   where: "steps[2].routes[1].steps[0]" (messages), ptr: "/steps/2/routes/1/steps/0" (schema paths)
 */
function mainSteps(spec) {
  return lineSteps(spec?.steps, 'steps')
}

/** The steps of one line (main line, multicast branch or local process) with the steps inside its routers' routes and its multicasts' branches */
function lineSteps(list, prefix, extra = {}) {
  const out = []
  const ptrOf = (where) => '/' + where.replace(/\[(\d+)\]/g, '/$1').replace(/\./g, '/')
  ;(Array.isArray(list) ? list : []).forEach((step, i) => {
    const where = `${prefix}[${i}]`
    out.push({ step, where, ptr: ptrOf(where), ...extra })
    if (step?.type === 'multicast' && Array.isArray(step.branches))
      step.branches.forEach((branch, j) => out.push(...lineSteps(branch?.steps, `${where}.branches[${j}].steps`, { ...extra, multicast: step, branch, branchIndex: j })))
    if (step?.type !== 'router' || !Array.isArray(step.routes)) return
    step.routes.forEach((route, j) =>
      (Array.isArray(route?.steps) ? route.steps : []).forEach((s, k) => {
        const at = `${where}.routes[${j}].steps[${k}]`
        out.push({ step: s, where: at, ptr: ptrOf(at), router: step, route, routeIndex: j, ...extra })
      })
    )
  })
  return out
}

/** Steps of the exception subprocess with their paths */
function exceptionSteps(spec) {
  const list = Array.isArray(spec?.exceptionSubprocess?.steps) ? spec.exceptionSubprocess.steps : []
  return list.map((step, i) => ({ step, where: `exceptionSubprocess.steps[${i}]`, ptr: `/exceptionSubprocess/steps/${i}` }))
}

/** The local processes of a spec ([] without), and their steps with their paths and process */
const localProcesses = (spec) => (Array.isArray(spec?.localProcesses) ? spec.localProcesses : [])
function localSteps(spec) {
  return localProcesses(spec).flatMap((process, i) => lineSteps(process?.steps, `localProcesses[${i}].steps`, { process }))
}

/** Every step: main flow (with route steps), exception subprocess and local processes */
const allSteps = (spec) => [...mainSteps(spec), ...exceptionSteps(spec), ...localSteps(spec)]

/**
 * A copy of the spec with fn(step, where) applied to every step of every list: the main line, the routes,
 * the multicast branches, the exception subprocess and the local processes (where: "steps[2].routes[1].steps[0]")
 */
function mapSteps(spec, fn) {
  const list = (steps, prefix) =>
    steps.map((s, i) => {
      const where = `${prefix}[${i}]`
      const step = fn(s, where)
      if (step?.type === 'multicast' && Array.isArray(step.branches))
        return { ...step, branches: step.branches.map((b, j) => (Array.isArray(b?.steps) ? { ...b, steps: list(b.steps, `${where}.branches[${j}].steps`) } : b)) }
      return step?.type === 'router' && Array.isArray(step.routes)
        ? { ...step, routes: step.routes.map((r, j) => (Array.isArray(r?.steps) ? { ...r, steps: list(r.steps, `${where}.routes[${j}].steps`) } : r)) }
        : step
    })
  return {
    ...spec,
    ...(Array.isArray(spec.steps) && { steps: list(spec.steps, 'steps') }),
    ...(Array.isArray(spec.exceptionSubprocess?.steps) && { exceptionSubprocess: { ...spec.exceptionSubprocess, steps: list(spec.exceptionSubprocess.steps, 'exceptionSubprocess.steps') } }),
    ...(Array.isArray(spec.localProcesses) && {
      localProcesses: spec.localProcesses.map((p, i) => (Array.isArray(p?.steps) ? { ...p, steps: list(p.steps, `localProcesses[${i}].steps`) } : p))
    })
  }
}

/** The value at a message path like "steps[2].routes[1].steps[0].properties[3].value" */
function valueAt(spec, path) {
  let v = spec
  for (const part of path.match(/[^.[\]]+/g) || []) v = v == null ? undefined : v[/^\d+$/.test(part) ? Number(part) : part]
  return v
}

module.exports = { lineSteps, mainSteps, exceptionSteps, localProcesses, localSteps, allSteps, mapSteps, valueAt }
