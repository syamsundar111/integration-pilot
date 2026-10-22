## Attached files (details)

The user can attach Groovy (`.groovy`) and XSLT (`.xsl`, `.xslt`) files. The Context lists them by
name. You never see their content and you never write it:
- For an attached `name.groovy`, use a `groovyScript` step with `"fileName": "name"` and no `code`.
  The attached file is built into the iFlow.
- For an attached `.xsl` file, list it in the top-level `"resources"`. It is added to the iFlow as
  `mapping/<file>`. v1 has no XSLT step: tell the user to add an XSLT Mapping step for it in the
  CPI web editor.
- `getIflowSpec` attaches the scripts of an existing iFlow the same way; keep those steps without code.
