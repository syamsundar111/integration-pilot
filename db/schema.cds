namespace iflowpilot;

using { cuid, managed } from '@sap/cds/common';

entity ChatSession : cuid, managed {
  title       : String(200);
  titleEdited : Boolean default false; // renamed by the user: automatic names (iFlow of a proposal or import) no longer apply
  defaults    : LargeString; // JSON { packageId?, timer?, authNote? }: session defaults from the chat panel
  draftSpec   : LargeString; // JSON { spec, source, at }: the conversation's working spec (e.g. an imported iFlow); scripts are attachments
  messages    : Composition of many ChatMessage on messages.session = $self;
  attachments : Composition of many Attachment on attachments.session = $self;
}

/**
 * A Groovy or XSLT file of a conversation. Specs reference it by file name and the builder
 * injects the content; the model only ever sees the name and size.
 */
entity Attachment : cuid, managed {
  session  : Association to ChatSession;
  fileName : String(255); // with extension, unique per session: mapUsers.groovy, transform.xsl
  kind     : String(10) enum { groovy; xsl };
  origin   : String(10) enum { upload; iflow; import; ai } default 'upload'; // iflow: script of an existing iFlow (getIflowSpec); ai: written with writeScript
  content  : LargeString;
  size     : Integer; // bytes
  lines    : Integer;
}

entity ChatMessage : cuid, managed {
  session   : Association to ChatSession;
  seq       : Integer; // order within the session (several messages share a timestamp)
  role      : String(20) enum { system; user; assistant; tool };
  content   : LargeString;
  toolCalls : LargeString; // JSON: OpenAI-style tool_calls (assistant) or tool_call_id (tool)
  usage     : LargeString; // JSON TurnUsage of the turn this final answer ends (assistant answers only)
}

/** One user message and the agent's (background) work on it; polled by the UI */
entity ChatTurn : cuid, managed {
  session         : Association to ChatSession;
  status          : String(20) enum { RUNNING; DONE; FAILED; CANCELLED } default 'RUNNING';
  message         : LargeString; // the user's message
  text            : LargeString; // final assistant answer
  events          : LargeString; // JSON [{ at, type, label, detail }] progress events
  proposals       : LargeString; // JSON proposals created in this turn
  error           : LargeString; // JSON { code, message, hint }
  cancelRequested : Boolean default false;
  // AI usage of the turn (model calls that answered; provider-neutral, see srv/lib/llm.js)
  modelCalls      : Integer default 0;
  inputTokens     : Integer default 0;
  outputTokens    : Integer default 0;
  totalTokens     : Integer default 0;
  durationMs      : Integer; // the whole turn, start to end
  model           : String(255); // model(s) that answered, comma-separated
  tokenBudget     : Integer; // AGENT_MAX_TOKENS_PER_MESSAGE when the turn ran
  stoppedAtBudget : Boolean default false;
}

type ProposalStatus : String(20) enum { PENDING; APPROVED; REJECTED; DONE; FAILED };

entity Proposal : cuid, managed {
  session   : Association to ChatSession;
  kind      : String(20) enum { IFLOW; PACKAGE };
  operation : String(10) enum { CREATE; UPDATE } default 'CREATE'; // iFlow proposals: new iFlow, or new content for an existing one
  spec      : LargeString; // JSON spec (iFlow spec v1 or package definition)
  status    : ProposalStatus default 'PENDING';
  iflowId   : String(255);
  packageId : String(255);
  packageName : String(255); // name for the package if it is created on approval (chosen by the user)
  attachments : LargeString; // JSON { fileName: content }: attached files the spec references, as proposed
  backupZip   : LargeString; // UPDATE proposals: the iFlow zip (base64) as it was before the update
  backup      : LargeString; // JSON { iflowId, version, savedVersion?, versionError?, sizeBytes, at }
  scriptChecks : LargeString; // JSON { fileName: { status: ok|failed|unchecked, errors?, reason?, at } }: Groovy check, at proposal and at approval
  changes      : LargeString; // UPDATE only, JSON { list: [text], scripts: { fileName: changed|unchanged|new } }: the actual diff against the current iFlow
  result    : LargeString; // JSON execution result (steps, deploy status)
  error     : LargeString;
}

entity AuditLog : cuid, managed {
  action     : String(60);  // e.g. CREATE_PACKAGE, DEPLOY_IFLOW
  targetType : String(30);  // Package | Iflow | Configuration | Proposal
  targetId   : String(255);
  status     : String(20) enum { SUCCESS; FAILED };
  details    : LargeString; // JSON
  user       : String(255);
}
