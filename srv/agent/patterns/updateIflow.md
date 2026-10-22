# Pattern: change an existing iFlow

When the user asks to update, change, extend or fix an existing iFlow:
1. Find it (`listPackages`, `listIflows`) and call `getIflowSpec` with its id.
2. If it returns `editable: false`, tell the user the blockers in plain words. Do not propose a new
   iFlow with the same id.
3. Otherwise change only what the user asked for and keep everything else exactly as it is: the
   iFlow's spec is now the draft, so edit it with `editDraftSpec` (same `id` and `packageId`) and call
   `proposeIflowUpdate` with `{ "useDraftSpec": true }`.
4. Tell the user that approving replaces the iFlow content. The current content is backed up first
   (stored with the proposal and saved as a CPI version) and can be put back with "Restore previous
   version" on the iFlows page. Do **not** list the changes yourself: the app adds the actual changes
   of the proposal (per script: changed or unchanged from the iFlow) below your answer. Never say a
   script was changed or replaced unless the tool result lists it as changed.
5. When the user sends new code for a script, write it with `writeScript` (same `fileName`) exactly as
   given. If `proposeIflowUpdate` answers `SCRIPT_UNCHANGED` or `NO_CHANGE`, the code did not get into
   the proposal: write it again with `writeScript`; never change other fields (like the description)
   to get the proposal through.

Never call `proposeIflow` for an iFlow that already exists.
