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
    // command-line tools report on the console
    files: ['scripts/**', 'srv/iflow-builder/derive-templates.js', 'test/ui/fake-backend.cjs'],
    rules: { 'no-console': 'off' }
  }
]
