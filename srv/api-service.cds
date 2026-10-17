using { iflowpilot as db } from '../db/schema';

/**
 * REST API for the dashboard. CPI-backed entities are not persisted
 * (@cds.persistence.skip) — every request is proxied to the tenant via srv/lib/cpi-client.js.
 */
@protocol: 'rest'
@path    : '/api'
@cds.server.body_parser.limit: '20mb' // uploaded iFlow zips (base64) for Explain
@requires: 'Admin' // XSUAA scope $XSAPPNAME.Admin (role collection IntegrationPilot_Admin); local dev: srv/lib/dev-auth.js
service ApiService {

  type ErrorInfo {
    code    : String;
    message : String;
    hint    : String;
  }

  // --- Health ---------------------------------------------------------------

  type Health {
    connected  : Boolean;
    tenantHost : String;
    latencyMs  : Integer;
    error      : ErrorInfo;
  }

  /** GET /api/health */
  function health() returns Health;

  type User {
    id : String;
  }

  /** GET /api/me — current user (top bar) */
  function me() returns User;

  type Stats {
    packages                : Integer;
    iflows                  : Integer;
    packagesNotReadable     : Integer;
    deployed                : Integer;
    started                 : Integer;
    starting                : Integer;
    error                   : Integer;
    failedMessages24h       : Integer;
    failedMessages24hCapped : Boolean;
    computedAt              : String;
    durationMs              : Integer;
  }

  /** GET /api/stats — dashboard KPIs; iFlow total loops over all packages; cached 30s (?fresh=true bypasses) */
  function stats(fresh : Boolean) returns Stats;

  // --- Packages -------------------------------------------------------------

  /**
   * GET/POST /api/Packages, GET/PATCH/DELETE /api/Packages/{id},
   * GET /api/Packages/{id}/iflows, GET /api/Packages/{id}/download
   */
  @cds.persistence.skip
  entity Packages {
    key id             : String(255);
        name           : String(255);
        shortText      : String(255);
        description    : LargeString;
        version        : String(50);
        vendor         : String(255);
        mode           : String(50);
        partnerContent : Boolean;
        createdBy      : String(255);
        createdAt      : String(30);
        modifiedBy     : String(255);
        modifiedAt     : String(30);
        iflows         : Association to many Iflows on iflows.packageId = id;
  } actions {
    /** Package export as zip (binary response) */
    function download() returns LargeBinary;
  }

  // --- iFlows ---------------------------------------------------------------

  type ConfigurationInput {
    ![key]   : String;
    value    : String;
    dataType : String;
  }

  type ResourceContent {
    name          : String;
    type          : String;
    content       : LargeString; // UTF-8 text for text resources (groovy, xsd, ...), else null
    contentBase64 : LargeString;
  }

  type DeployResult {
    taskId : String;
  }

  type IflowBackup {
    proposalId   : UUID;
    createdAt    : Timestamp;
    iflowId      : String;
    version      : String; // version of the iFlow when it was backed up
    savedVersion : String; // CPI version saved before the update (if it worked)
    versionError : String;
    sizeBytes    : Integer;
    at           : String;
  }

  type RestoreResult {
    iflowId        : String;
    restoredFrom   : IflowBackup;
    savedCurrentAs : String; // CPI version the replaced content was saved as
    warning        : String;
  }

  /**
   * GET/PATCH/DELETE /api/Iflows/{id} (Version='active'), POST /api/Iflows,
   * GET /api/Iflows/{id}/configurations | resources | runtime
   */
  @cds.persistence.skip
  entity Iflows {
    key id             : String(255);
        version        : String(50);
        packageId      : String(255);
        name           : String(255);
        description    : LargeString;
        sender         : String(255);
        receiver       : String(255);
        createdBy      : String(255);
        createdAt      : String(30);
        modifiedBy     : String(255);
        modifiedAt     : String(30);
        zipBase64      : LargeString; // write-only: content for POST/PATCH
        configurations : Association to many Configurations on configurations.iflowId = id;
        resources      : Association to many Resources on resources.iflowId = id;
        runtime        : Association to one RuntimeArtifacts on runtime.id = id;
  } actions {
    /** iFlow zip (binary response) */
    function download()                                         returns LargeBinary;
    /** Content of one resource, e.g. ?name=script1.groovy&type=groovy */
    function resource(name : String, type : String)             returns ResourceContent;
    /** Parsed structure (trigger, steps, adapters, parameters, scripts) for the Overview/Scripts tabs */
    function parsed()                                           returns LargeString;
    action   updateConfigurations(parameters : many ConfigurationInput) returns many Configurations;
    /** Backups stored before updates by approved proposals, newest first */
    function backups()                                          returns many IflowBackup;
    /** Puts a backup back as the iFlow's content (latest backup without proposalId); not deployed */
    action   restore(proposalId : UUID)                         returns RestoreResult;
    action   deploy()                                           returns DeployResult;
    action   undeploy();
  }

  @readonly
  @cds.persistence.skip
  entity Configurations {
    key iflowId  : String(255);
    key ![key]   : String(255);
        value    : LargeString;
        dataType : String(50);
  }

  @readonly
  @cds.persistence.skip
  entity Resources {
    key iflowId        : String(255);
    key name           : String(255);
    key type           : String(50);
        referencedType : String(50);
  }

  // --- Runtime --------------------------------------------------------------

  type RuntimeError {
    message : LargeString;
    details : LargeString; // raw ErrorInformation payload from CPI
  }

  /** GET /api/RuntimeArtifacts, GET /api/RuntimeArtifacts/{id}, GET /api/RuntimeArtifacts/{id}/errorInfo */
  @readonly
  @cds.persistence.skip
  entity RuntimeArtifacts {
    key id         : String(255);
        version    : String(50);
        name       : String(255);
        type       : String(50);
        status     : String(30); // STARTED | STARTING | ERROR | STOPPING ...
        deployedBy : String(255);
        deployedOn : String(30);
  } actions {
    function errorInfo() returns RuntimeError;
  }

  // --- Monitoring -----------------------------------------------------------

  type MessageLog {
    messageGuid          : String;
    correlationId        : String;
    applicationMessageId : String;
    integrationFlowName  : String;
    iflowId              : String;
    packageId            : String;
    packageName          : String;
    status               : String;
    customStatus         : String;
    logLevel             : String;
    sender               : String;
    receiver             : String;
    logStart             : String;
    logEnd               : String;
  }

  /** GET /api/messageLogs?status=FAILED&top=50&sinceHours=24 (all optional) */
  function messageLogs(status : String, top : Integer, sinceHours : Integer) returns many MessageLog;

  // --- AI agent -------------------------------------------------------------

  type LlmHealth {
    ok        : Boolean;
    model     : String; // the model that answered
    fallbackUsed : Boolean;
    latencyMs : Integer;
    reply     : String;
    error     : ErrorInfo;
  }

  /** GET /api/llm-health (alias of /api/llmHealth): tiny prompt via destination NVIDIA_LLM */
  function llmHealth() returns LlmHealth;

  type ProposalInfo {
    ID        : UUID;
    kind      : String;
    operation : String; // CREATE | UPDATE (iFlow proposals)
    status    : String;
    iflowId   : String;
    packageId : String;
    spec      : LargeString; // object in responses
    createdAt : Timestamp;
  }

  /** Session defaults from the chat panel; sent with each message, stored on the session */
  type SessionDefaults {
    packageId : String; // target package id
    timer     : String; // 'once' = timer, run once after deployment
    authNote  : String; // receiver authentication to set up after creation
  }

  /** A .groovy or .xsl/.xslt file sent with a chat message (UTF-8 text) */
  type AttachmentInput {
    fileName : String;
    content  : LargeString;
  }

  type TurnStarted {
    turnId    : UUID;
    sessionId : UUID;
    status    : String;
  }

  /**
   * POST /api/chat { sessionId?, message, defaults?, attachments? } — starts a turn and returns at once
   * (omit sessionId to start a new conversation). Poll GET /api/chat/turns/{turnId}.
   * defaults replace the session's stored defaults; omit them to keep the stored ones.
   * attachments are stored in the session (same name: replaced); specs reference them by file name.
   */
  action chat(sessionId : UUID, message : String, defaults : SessionDefaults, attachments : many AttachmentInput) returns TurnStarted;

  /**
   * GET /api/chat/turns/{id} (alias of /api/ChatTurns/{id}): status RUNNING|DONE|FAILED|CANCELLED,
   * events [{ at, type, label, detail }], text, proposals, error.
   * POST /api/chat/turns/{id}/cancel
   */
  @readonly
  entity ChatTurns    as projection on db.ChatTurn actions {
    action cancel() returns ChatTurns;
  };

  /**
   * GET /api/ChatSessions?$orderby=modifiedAt desc, GET /api/ChatSessions/{id}/messages?$orderby=seq,
   * POST /api/ChatSessions/{id}/remove (deletes the conversation; executed proposals are kept)
   */
  @readonly
  entity ChatSessions as projection on db.ChatSession actions {
    action remove();
  };

  @readonly
  entity ChatMessages as projection on db.ChatMessage;

  /**
   * GET /api/Attachments?$filter=session_ID eq <id> — attached files without content,
   * POST /api/Attachments/{id}/remove
   */
  @readonly
  entity Attachments  as projection on db.Attachment excluding { content } actions {
    action remove();
  };

  /**
   * GET /api/Proposals/{id} (poll during execution: status + result.steps),
   * POST /api/Proposals/{id}/approve { deploy }, POST /api/Proposals/{id}/reject { reason },
   * POST /api/Proposals/{id}/retry { deploy? } (FAILED only; deploy defaults to the previous choice)
   */
  @readonly
  entity Proposals    as projection on db.Proposal excluding { backupZip } actions {
    action approve(deploy : Boolean) returns Proposals;
    action reject(reason : String)   returns Proposals;
    action retry(deploy : Boolean)   returns Proposals;
    /** PENDING iFlow proposals: use an existing package, or name a new one (created on approval) */
    action setPackage(packageId : String, packageName : String) returns Proposals;
  };

  type ImportResult {
    sessionId    : UUID;
    spec         : LargeString; // draft spec (object in responses)
    notes        : many String;
    attachments  : many String; // attached files the draft references
    placeholders : Integer;
    valid        : Boolean;
    errors       : many String;
  }

  /**
   * POST /api/importIflow { sessionId?, fileName, contentBase64, packageId? } — converts an iFlow
   * (.zip export or .iflw) into the conversation's draft spec; unsupported steps become placeholders
   */
  action importIflow(sessionId : UUID, fileName : String, contentBase64 : LargeString, packageId : String) returns ImportResult;

  type Explanation {
    summary     : LargeString; // parsed iFlow (object in responses)
    explanation : LargeString; // Markdown from the LLM, null if it was unavailable
    model       : String;
    error       : ErrorInfo;
  }

  /** POST /api/explain { iflowId } or { zipBase64 } — parsed summary + AI explanation */
  action explain(iflowId : String, zipBase64 : LargeString) returns Explanation;

  // --- AI usage -------------------------------------------------------------

  type UsageTotals {
    requests            : Integer;
    failed              : Integer;
    modelCalls          : Integer;
    inputTokens         : Integer;
    outputTokens        : Integer;
    totalTokens         : Integer;
    durationMs          : Integer;
    avgTokensPerRequest : Integer;
  }

  type UsageDay : UsageTotals {
    day : String;
  }

  type UsageModel : UsageTotals {
    model : String;
  }

  type UsageSummary {
    days    : Integer;
    since   : String;
    totals  : UsageTotals;
    byDay   : many UsageDay;
    byModel : many UsageModel;
  }

  /** GET /api/usage(days=30) — AI usage of chat requests (tokens, model calls) for the Activity page */
  function usage(days : Integer) returns UsageSummary;

  // --- History --------------------------------------------------------------

  /** GET /api/AuditLog?$orderby=createdAt desc&$top=50 */
  @readonly
  entity AuditLog as projection on db.AuditLog;
}
