import cds from '@sap/cds/eslint.config.mjs'

export default [
  ...cds.recommended,
  {
    // `const { code, ...rest } = step` drops a property on purpose
    rules: { 'no-unused-vars': ['warn', { ignoreRestSiblings: true, argsIgnorePattern: '^_' }] }
  },
  {
    // wdi5/WebdriverIO UI tests: the browser and its helpers are globals; fake-backend code also runs in the page
    files: ['test/ui/**'],
    languageOptions: { globals: { browser: 'readonly', $: 'readonly', $$: 'readonly', expect: 'readonly', sap: 'readonly', driver: 'readonly' } }
  },
  {
    // the UI5 app runs in the browser: FileReader reads the files users pick (the other browser globals come with cds)
    files: ['app/integration-pilot/webapp/**'],
    languageOptions: { globals: { FileReader: 'readonly' } }
  },
  {
    // command-line tools report on the console
    files: ['scripts/**', 'srv/iflow-builder/derive-templates.js', 'test/ui/fake-backend.cjs'],
    rules: { 'no-console': 'off' }
  }
]
