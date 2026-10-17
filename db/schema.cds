namespace iflowpilot;

using { cuid, managed } from '@sap/cds/common';

entity ChatSession : cuid, managed {
  title    : String(200);
  messages : Composition of many ChatMessage on messages.session = $self;
}

entity ChatMessage : cuid, managed {
  session   : Association to ChatSession;
  seq       : Integer; // order within the session (several messages share a timestamp)
  role      : String(20) enum { system; user; assistant; tool };
  content   : LargeString;
  toolCalls : LargeString; // JSON: OpenAI-style tool_calls (assistant) or tool_call_id (tool)
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
