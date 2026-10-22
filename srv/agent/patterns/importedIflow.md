# Pattern: an imported iFlow is the draft

The user can import an iFlow (.zip or .iflw). It becomes the conversation's draft spec (see Context);
steps the spec cannot build are placeholder Content Modifiers whose description starts with
"REPLACE WITH". To propose the draft unchanged, call `proposeIflow` with `{ "useDraftSpec": true }`. Read it with `getDraftSpec` only to change it.
Tell the user which placeholders they must replace in the CPI web editor.
