-- CreateTable
CREATE TABLE "Novel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "coverUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "formatting" TEXT NOT NULL DEFAULT '{}'
);

-- CreateTable
CREATE TABLE "Volume" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "novelId" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Volume_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Chapter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 0,
    "order" INTEGER NOT NULL,
    "volumeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deleted" BOOLEAN NOT NULL DEFAULT false,
    CONSTRAINT "Chapter_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentConversation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "role" TEXT NOT NULL,
    "runtimeConversationId" TEXT,
    "suggestedGoal" TEXT,
    "planJson" TEXT,
    "runJson" TEXT,
    "contextSummaryJson" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentConversation_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadataJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "currentStepId" TEXT,
    "progress" REAL NOT NULL DEFAULT 0,
    "draftSessionId" TEXT,
    "cancelRequested" INTEGER NOT NULL DEFAULT 0,
    "pendingApprovalJson" TEXT,
    "approvalResponsesJson" TEXT,
    "planJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentRun_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRunEvent" (
    "eventId" TEXT NOT NULL PRIMARY KEY,
    "sequence" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "planId" TEXT,
    "threadId" TEXT,
    "stepId" TEXT,
    "type" TEXT NOT NULL,
    "agent" TEXT,
    "toolName" TEXT,
    "status" TEXT,
    "payloadJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AgentRunEvent_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("runId") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentArtifact" (
    "artifactId" TEXT NOT NULL PRIMARY KEY,
    "conversationId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "summary" TEXT,
    "content" TEXT,
    "referenceJson" TEXT,
    "metadataJson" TEXT,
    "reviewStatus" TEXT NOT NULL DEFAULT 'unreviewed',
    "reviewRevision" INTEGER NOT NULL DEFAULT 0,
    "reviewDecisionsJson" TEXT,
    "reviewStaleChapterIdsJson" TEXT,
    "reviewedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AgentArtifact_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AgentConversation" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentArtifact_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun" ("runId") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AgentArtifact_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AgentRevisionTask" (
    "revisionTaskId" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "sourceArtifactId" TEXT NOT NULL,
    "sourceFindingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "targetChapterIdsJson" TEXT NOT NULL,
    "sourceExpert" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "recommendedRole" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sourceSnapshotJson" TEXT NOT NULL,
    "note" TEXT,
    "planId" TEXT,
    "planJson" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SyncState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'global',
    "cursor" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "avatar" TEXT,
    "fullBodyImages" TEXT,
    "description" TEXT,
    "profile" TEXT NOT NULL DEFAULT '{}',
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "novelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Character_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'item',
    "icon" TEXT,
    "description" TEXT,
    "profile" TEXT NOT NULL DEFAULT '{}',
    "novelId" TEXT NOT NULL,
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Item_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ItemOwnership" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ItemOwnership_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ItemOwnership_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "Item" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorldSetting" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "type" TEXT NOT NULL DEFAULT 'other',
    "icon" TEXT,
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "novelId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "WorldSetting_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Relationship" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "relation" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Relationship_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Relationship_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Idea" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "content" TEXT NOT NULL,
    "quote" TEXT,
    "cursor" TEXT,
    "isStarred" BOOLEAN NOT NULL DEFAULT false,
    "novelId" TEXT NOT NULL,
    "chapterId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Idea_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Idea_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "novelId" TEXT NOT NULL,
    CONSTRAINT "Tag_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlotLine" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL,
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlotLine_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlotPoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "plotLineId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "icon" TEXT,
    "order" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlotPoint_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlotPoint_plotLineId_fkey" FOREIGN KEY ("plotLineId") REFERENCES "PlotLine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlotPointAnchor" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "plotPointId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "lexicalKey" TEXT,
    "offset" INTEGER,
    "length" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PlotPointAnchor_plotPointId_fkey" FOREIGN KEY ("plotPointId") REFERENCES "PlotPoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PlotPointAnchor_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MapCanvas" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'world',
    "description" TEXT,
    "background" TEXT,
    "width" INTEGER NOT NULL DEFAULT 1200,
    "height" INTEGER NOT NULL DEFAULT 800,
    "sortOrder" REAL NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "MapElement" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "mapId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "text" TEXT,
    "iconKey" TEXT,
    "style" TEXT NOT NULL DEFAULT '{}',
    "z" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "MapElement_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "MapCanvas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "CharacterMapMarker" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "mapId" TEXT NOT NULL,
    "x" REAL NOT NULL,
    "y" REAL NOT NULL,
    "label" TEXT,
    CONSTRAINT "CharacterMapMarker_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "CharacterMapMarker_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "MapCanvas" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ChapterSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "volumeId" TEXT NOT NULL,
    "chapterId" TEXT NOT NULL,
    "summaryType" TEXT NOT NULL DEFAULT 'standard',
    "summaryText" TEXT NOT NULL,
    "compressedMemory" TEXT,
    "keyFacts" TEXT NOT NULL DEFAULT '[]',
    "entitiesSnapshot" TEXT NOT NULL DEFAULT '{}',
    "timelineHints" TEXT NOT NULL DEFAULT '[]',
    "openQuestions" TEXT NOT NULL DEFAULT '[]',
    "sourceContentHash" TEXT NOT NULL,
    "sourceWordCount" INTEGER NOT NULL DEFAULT 0,
    "sourceUpdatedAt" DATETIME NOT NULL,
    "chapterOrder" INTEGER,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "qualityScore" REAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ChapterSummary_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChapterSummary_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ChapterSummary_chapterId_fkey" FOREIGN KEY ("chapterId") REFERENCES "Chapter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "NarrativeSummary" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "novelId" TEXT NOT NULL,
    "volumeId" TEXT,
    "level" TEXT NOT NULL DEFAULT 'novel',
    "title" TEXT,
    "summaryText" TEXT NOT NULL,
    "keyFacts" TEXT NOT NULL DEFAULT '[]',
    "unresolvedThreads" TEXT NOT NULL DEFAULT '[]',
    "styleGuide" TEXT NOT NULL DEFAULT '[]',
    "hardConstraints" TEXT NOT NULL DEFAULT '[]',
    "coverageChapterIds" TEXT NOT NULL DEFAULT '[]',
    "chapterRangeStart" INTEGER,
    "chapterRangeEnd" INTEGER,
    "sourceFingerprint" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "promptVersion" TEXT,
    "temperature" REAL,
    "maxTokens" INTEGER,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "qualityScore" REAL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "errorCode" TEXT,
    "errorDetail" TEXT,
    "isLatest" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "NarrativeSummary_novelId_fkey" FOREIGN KEY ("novelId") REFERENCES "Novel" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "NarrativeSummary_volumeId_fkey" FOREIGN KEY ("volumeId") REFERENCES "Volume" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "_IdeaToTag" (
    "A" TEXT NOT NULL,
    "B" TEXT NOT NULL,
    CONSTRAINT "_IdeaToTag_A_fkey" FOREIGN KEY ("A") REFERENCES "Idea" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "_IdeaToTag_B_fkey" FOREIGN KEY ("B") REFERENCES "Tag" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "idx_agent_conversation_novel_updated" ON "AgentConversation"("novelId", "updatedAt");

-- CreateIndex
CREATE INDEX "idx_agent_message_conversation_created" ON "AgentMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "idx_agent_run_conversation_updated" ON "AgentRun"("conversationId", "updatedAt");

-- CreateIndex
CREATE INDEX "idx_agent_run_event_run_sequence" ON "AgentRunEvent"("runId", "sequence");

-- CreateIndex
CREATE INDEX "idx_agent_artifact_conversation_created" ON "AgentArtifact"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "idx_agent_artifact_run_created" ON "AgentArtifact"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "idx_agent_revision_task_novel_status" ON "AgentRevisionTask"("novelId", "status", "updatedAt");

-- CreateIndex
CREATE INDEX "idx_agent_revision_task_artifact" ON "AgentRevisionTask"("sourceArtifactId", "sourceFindingId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRevisionTask_sourceArtifactId_sourceFindingId_key" ON "AgentRevisionTask"("sourceArtifactId", "sourceFindingId");

-- CreateIndex
CREATE UNIQUE INDEX "ItemOwnership_characterId_itemId_key" ON "ItemOwnership"("characterId", "itemId");

-- CreateIndex
CREATE UNIQUE INDEX "Relationship_sourceId_targetId_key" ON "Relationship"("sourceId", "targetId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_name_novelId_key" ON "Tag"("name", "novelId");

-- CreateIndex
CREATE INDEX "MapCanvas_novelId_idx" ON "MapCanvas"("novelId");

-- CreateIndex
CREATE INDEX "MapElement_mapId_idx" ON "MapElement"("mapId");

-- CreateIndex
CREATE UNIQUE INDEX "CharacterMapMarker_characterId_mapId_key" ON "CharacterMapMarker"("characterId", "mapId");

-- CreateIndex
CREATE INDEX "ChapterSummary_chapterId_isLatest_idx" ON "ChapterSummary"("chapterId", "isLatest");

-- CreateIndex
CREATE INDEX "ChapterSummary_novelId_status_createdAt_idx" ON "ChapterSummary"("novelId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "ChapterSummary_volumeId_createdAt_idx" ON "ChapterSummary"("volumeId", "createdAt");

-- CreateIndex
CREATE INDEX "ChapterSummary_sourceContentHash_idx" ON "ChapterSummary"("sourceContentHash");

-- CreateIndex
CREATE UNIQUE INDEX "ChapterSummary_chapterId_sourceContentHash_summaryType_key" ON "ChapterSummary"("chapterId", "sourceContentHash", "summaryType");

-- CreateIndex
CREATE INDEX "NarrativeSummary_novelId_level_status_createdAt_idx" ON "NarrativeSummary"("novelId", "level", "status", "createdAt");

-- CreateIndex
CREATE INDEX "NarrativeSummary_volumeId_status_createdAt_idx" ON "NarrativeSummary"("volumeId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "NarrativeSummary_novelId_volumeId_level_sourceFingerprint_key" ON "NarrativeSummary"("novelId", "volumeId", "level", "sourceFingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "_IdeaToTag_AB_unique" ON "_IdeaToTag"("A", "B");

-- CreateIndex
CREATE INDEX "_IdeaToTag_B_index" ON "_IdeaToTag"("B");

