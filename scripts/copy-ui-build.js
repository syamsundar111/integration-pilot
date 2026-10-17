// Copies the SAPUI5 app build (app/integration-pilot/dist) into the approuter (app/router/resources). Used by the MTA build.
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const from = path.join(root, 'app', 'integration-pilot', 'dist')
const to = path.join(root, 'app', 'router', 'resources')

if (!fs.existsSync(path.join(from, 'index.html'))) {
  console.error('app/integration-pilot/dist/index.html not found — run "npm run ui:build" first')
  process.exit(1)
}
fs.rmSync(to, { recursive: true, force: true })
fs.cpSync(from, to, { recursive: true })
console.log(`Copied ${path.relative(root, from)} -> ${path.relative(root, to)}`)
