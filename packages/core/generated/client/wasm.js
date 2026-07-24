
Object.defineProperty(exports, "__esModule", { value: true });

const {
  Decimal,
  objectEnumValues,
  makeStrictEnum,
  Public,
  detectRuntime,
} = require('./runtime/index-browser.js')


const Prisma = {}

exports.Prisma = Prisma
exports.$Enums = {}

/**
 * Prisma Client JS version: 5.10.2
 * Query Engine version: 5a9203d0590c951969e85a7d07215503f4672eb9
 */
Prisma.prismaVersion = {
  client: "5.10.2",
  engine: "5a9203d0590c951969e85a7d07215503f4672eb9"
}

Prisma.PrismaClientKnownRequestError = () => {
  throw new Error(`PrismaClientKnownRequestError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)};
Prisma.PrismaClientUnknownRequestError = () => {
  throw new Error(`PrismaClientUnknownRequestError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientRustPanicError = () => {
  throw new Error(`PrismaClientRustPanicError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientInitializationError = () => {
  throw new Error(`PrismaClientInitializationError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.PrismaClientValidationError = () => {
  throw new Error(`PrismaClientValidationError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.NotFoundError = () => {
  throw new Error(`NotFoundError is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.Decimal = Decimal

/**
 * Re-export of sql-template-tag
 */
Prisma.sql = () => {
  throw new Error(`sqltag is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.empty = () => {
  throw new Error(`empty is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.join = () => {
  throw new Error(`join is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.raw = () => {
  throw new Error(`raw is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.validator = Public.validator

/**
* Extensions
*/
Prisma.getExtensionContext = () => {
  throw new Error(`Extensions.getExtensionContext is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}
Prisma.defineExtension = () => {
  throw new Error(`Extensions.defineExtension is unable to be run ${runtimeDescription}.
In case this error is unexpected for you, please report it in https://pris.ly/prisma-prisma-bug-report`,
)}

/**
 * Shorthand utilities for JSON filtering
 */
Prisma.DbNull = objectEnumValues.instances.DbNull
Prisma.JsonNull = objectEnumValues.instances.JsonNull
Prisma.AnyNull = objectEnumValues.instances.AnyNull

Prisma.NullTypes = {
  DbNull: objectEnumValues.classes.DbNull,
  JsonNull: objectEnumValues.classes.JsonNull,
  AnyNull: objectEnumValues.classes.AnyNull
}

/**
 * Enums
 */

exports.Prisma.TransactionIsolationLevel = makeStrictEnum({
  Serializable: 'Serializable'
});

exports.Prisma.NovelScalarFieldEnum = {
  id: 'id',
  title: 'title',
  description: 'description',
  coverUrl: 'coverUrl',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  version: 'version',
  deleted: 'deleted',
  wordCount: 'wordCount',
  formatting: 'formatting'
};

exports.Prisma.VolumeScalarFieldEnum = {
  id: 'id',
  title: 'title',
  order: 'order',
  novelId: 'novelId',
  version: 'version',
  deleted: 'deleted',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ChapterScalarFieldEnum = {
  id: 'id',
  title: 'title',
  content: 'content',
  wordCount: 'wordCount',
  order: 'order',
  volumeId: 'volumeId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
  version: 'version',
  deleted: 'deleted'
};

exports.Prisma.AgentConversationScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  title: 'title',
  description: 'description',
  role: 'role',
  runtimeConversationId: 'runtimeConversationId',
  suggestedGoal: 'suggestedGoal',
  planJson: 'planJson',
  runJson: 'runJson',
  contextSummaryJson: 'contextSummaryJson',
  error: 'error',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AgentMessageScalarFieldEnum = {
  id: 'id',
  conversationId: 'conversationId',
  role: 'role',
  content: 'content',
  metadataJson: 'metadataJson',
  createdAt: 'createdAt'
};

exports.Prisma.AgentRunScalarFieldEnum = {
  runId: 'runId',
  conversationId: 'conversationId',
  novelId: 'novelId',
  threadId: 'threadId',
  planId: 'planId',
  status: 'status',
  currentStepId: 'currentStepId',
  progress: 'progress',
  draftSessionId: 'draftSessionId',
  cancelRequested: 'cancelRequested',
  pendingApprovalJson: 'pendingApprovalJson',
  approvalResponsesJson: 'approvalResponsesJson',
  planJson: 'planJson',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AgentRunEventScalarFieldEnum = {
  eventId: 'eventId',
  sequence: 'sequence',
  runId: 'runId',
  planId: 'planId',
  threadId: 'threadId',
  stepId: 'stepId',
  type: 'type',
  agent: 'agent',
  toolName: 'toolName',
  status: 'status',
  payloadJson: 'payloadJson',
  createdAt: 'createdAt'
};

exports.Prisma.AgentArtifactScalarFieldEnum = {
  artifactId: 'artifactId',
  conversationId: 'conversationId',
  runId: 'runId',
  novelId: 'novelId',
  planId: 'planId',
  type: 'type',
  title: 'title',
  status: 'status',
  summary: 'summary',
  content: 'content',
  referenceJson: 'referenceJson',
  metadataJson: 'metadataJson',
  reviewStatus: 'reviewStatus',
  reviewRevision: 'reviewRevision',
  reviewDecisionsJson: 'reviewDecisionsJson',
  reviewStaleChapterIdsJson: 'reviewStaleChapterIdsJson',
  reviewedAt: 'reviewedAt',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.AgentRevisionTaskScalarFieldEnum = {
  revisionTaskId: 'revisionTaskId',
  novelId: 'novelId',
  sourceArtifactId: 'sourceArtifactId',
  sourceFindingId: 'sourceFindingId',
  title: 'title',
  description: 'description',
  targetChapterIdsJson: 'targetChapterIdsJson',
  sourceExpert: 'sourceExpert',
  severity: 'severity',
  recommendedRole: 'recommendedRole',
  status: 'status',
  sourceSnapshotJson: 'sourceSnapshotJson',
  note: 'note',
  planId: 'planId',
  planJson: 'planJson',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SyncStateScalarFieldEnum = {
  id: 'id',
  cursor: 'cursor',
  updatedAt: 'updatedAt'
};

exports.Prisma.CharacterScalarFieldEnum = {
  id: 'id',
  name: 'name',
  role: 'role',
  avatar: 'avatar',
  fullBodyImages: 'fullBodyImages',
  description: 'description',
  profile: 'profile',
  sortOrder: 'sortOrder',
  isStarred: 'isStarred',
  novelId: 'novelId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ItemScalarFieldEnum = {
  id: 'id',
  name: 'name',
  type: 'type',
  icon: 'icon',
  description: 'description',
  profile: 'profile',
  novelId: 'novelId',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.ItemOwnershipScalarFieldEnum = {
  id: 'id',
  characterId: 'characterId',
  itemId: 'itemId',
  note: 'note',
  createdAt: 'createdAt'
};

exports.Prisma.WorldSettingScalarFieldEnum = {
  id: 'id',
  name: 'name',
  content: 'content',
  type: 'type',
  icon: 'icon',
  sortOrder: 'sortOrder',
  novelId: 'novelId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.RelationshipScalarFieldEnum = {
  id: 'id',
  sourceId: 'sourceId',
  targetId: 'targetId',
  relation: 'relation',
  description: 'description',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.IdeaScalarFieldEnum = {
  id: 'id',
  content: 'content',
  quote: 'quote',
  cursor: 'cursor',
  isStarred: 'isStarred',
  novelId: 'novelId',
  chapterId: 'chapterId',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.TagScalarFieldEnum = {
  id: 'id',
  name: 'name',
  novelId: 'novelId'
};

exports.Prisma.PlotLineScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  name: 'name',
  description: 'description',
  color: 'color',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PlotPointScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  plotLineId: 'plotLineId',
  title: 'title',
  description: 'description',
  type: 'type',
  status: 'status',
  icon: 'icon',
  order: 'order',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.PlotPointAnchorScalarFieldEnum = {
  id: 'id',
  plotPointId: 'plotPointId',
  chapterId: 'chapterId',
  type: 'type',
  lexicalKey: 'lexicalKey',
  offset: 'offset',
  length: 'length',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MapCanvasScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  name: 'name',
  type: 'type',
  description: 'description',
  background: 'background',
  width: 'width',
  height: 'height',
  sortOrder: 'sortOrder',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.MapElementScalarFieldEnum = {
  id: 'id',
  mapId: 'mapId',
  type: 'type',
  x: 'x',
  y: 'y',
  text: 'text',
  iconKey: 'iconKey',
  style: 'style',
  z: 'z'
};

exports.Prisma.CharacterMapMarkerScalarFieldEnum = {
  id: 'id',
  characterId: 'characterId',
  mapId: 'mapId',
  x: 'x',
  y: 'y',
  label: 'label'
};

exports.Prisma.ChapterSummaryScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  volumeId: 'volumeId',
  chapterId: 'chapterId',
  summaryType: 'summaryType',
  summaryText: 'summaryText',
  compressedMemory: 'compressedMemory',
  keyFacts: 'keyFacts',
  entitiesSnapshot: 'entitiesSnapshot',
  timelineHints: 'timelineHints',
  openQuestions: 'openQuestions',
  sourceContentHash: 'sourceContentHash',
  sourceWordCount: 'sourceWordCount',
  sourceUpdatedAt: 'sourceUpdatedAt',
  chapterOrder: 'chapterOrder',
  provider: 'provider',
  model: 'model',
  promptVersion: 'promptVersion',
  temperature: 'temperature',
  maxTokens: 'maxTokens',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  latencyMs: 'latencyMs',
  qualityScore: 'qualityScore',
  status: 'status',
  errorCode: 'errorCode',
  errorDetail: 'errorDetail',
  isLatest: 'isLatest',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.NarrativeSummaryScalarFieldEnum = {
  id: 'id',
  novelId: 'novelId',
  volumeId: 'volumeId',
  level: 'level',
  title: 'title',
  summaryText: 'summaryText',
  keyFacts: 'keyFacts',
  unresolvedThreads: 'unresolvedThreads',
  styleGuide: 'styleGuide',
  hardConstraints: 'hardConstraints',
  coverageChapterIds: 'coverageChapterIds',
  chapterRangeStart: 'chapterRangeStart',
  chapterRangeEnd: 'chapterRangeEnd',
  sourceFingerprint: 'sourceFingerprint',
  provider: 'provider',
  model: 'model',
  promptVersion: 'promptVersion',
  temperature: 'temperature',
  maxTokens: 'maxTokens',
  inputTokens: 'inputTokens',
  outputTokens: 'outputTokens',
  latencyMs: 'latencyMs',
  qualityScore: 'qualityScore',
  status: 'status',
  errorCode: 'errorCode',
  errorDetail: 'errorDetail',
  isLatest: 'isLatest',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

exports.Prisma.SortOrder = {
  asc: 'asc',
  desc: 'desc'
};

exports.Prisma.NullsOrder = {
  first: 'first',
  last: 'last'
};


exports.Prisma.ModelName = {
  Novel: 'Novel',
  Volume: 'Volume',
  Chapter: 'Chapter',
  AgentConversation: 'AgentConversation',
  AgentMessage: 'AgentMessage',
  AgentRun: 'AgentRun',
  AgentRunEvent: 'AgentRunEvent',
  AgentArtifact: 'AgentArtifact',
  AgentRevisionTask: 'AgentRevisionTask',
  SyncState: 'SyncState',
  Character: 'Character',
  Item: 'Item',
  ItemOwnership: 'ItemOwnership',
  WorldSetting: 'WorldSetting',
  Relationship: 'Relationship',
  Idea: 'Idea',
  Tag: 'Tag',
  PlotLine: 'PlotLine',
  PlotPoint: 'PlotPoint',
  PlotPointAnchor: 'PlotPointAnchor',
  MapCanvas: 'MapCanvas',
  MapElement: 'MapElement',
  CharacterMapMarker: 'CharacterMapMarker',
  ChapterSummary: 'ChapterSummary',
  NarrativeSummary: 'NarrativeSummary'
};

/**
 * This is a stub Prisma Client that will error at runtime if called.
 */
class PrismaClient {
  constructor() {
    return new Proxy(this, {
      get(target, prop) {
        const runtime = detectRuntime()
        const edgeRuntimeName = {
          'workerd': 'Cloudflare Workers',
          'deno': 'Deno and Deno Deploy',
          'netlify': 'Netlify Edge Functions',
          'edge-light': 'Vercel Edge Functions or Edge Middleware',
        }[runtime]

        let message = 'PrismaClient is unable to run in '
        if (edgeRuntimeName !== undefined) {
          message += edgeRuntimeName + '. As an alternative, try Accelerate: https://pris.ly/d/accelerate.'
        } else {
          message += 'this browser environment, or has been bundled for the browser (running in `' + runtime + '`).'
        }
        
        message += `
If this is unexpected, please open an issue: https://pris.ly/prisma-prisma-bug-report`

        throw new Error(message)
      }
    })
  }
}

exports.PrismaClient = PrismaClient

Object.assign(exports, Prisma)
