import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const desktopRoot = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, (value) => value.slice(1)));
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'novel-editor-context-coordinator-'));
assert.equal(path.dirname(tempRoot), os.tmpdir());

try {
    const entry = path.join(desktopRoot, 'electron', 'ai', 'context', 'AgentContextCompressionCoordinator.ts');
    const program = ts.createProgram([entry], {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        esModuleInterop: true,
        skipLibCheck: true,
        rootDir: desktopRoot,
        outDir: tempRoot,
    });
    const emitted = program.emit();
    assert.equal(emitted.emitSkipped, false);
    await fs.writeFile(path.join(tempRoot, 'package.json'), '{"type":"commonjs"}', 'utf8');
    const require = createRequire(import.meta.url);
    const { AgentContextCompressionCoordinator } = require(path.join(
        tempRoot,
        'electron',
        'ai',
        'context',
        'AgentContextCompressionCoordinator.js',
    ));
    const { AgentConversationCompactor } = require(path.join(
        tempRoot,
        'electron',
        'ai',
        'context',
        'AgentConversationCompactor.js',
    ));

    const emptyProjection = () => ({
        activeIntent: [],
        hardConstraints: [],
        confirmedDecisions: [],
        canonFacts: [],
        creativeContinuity: [],
        unresolvedQuestions: [],
        completedOutcomes: [],
        pendingWork: [],
        artifactRefs: [],
    });
    const messages = Array.from({ length: 32 }, (_, index) => ({
        messageId: `m-${index + 1}`,
        sequence: index + 1,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${index % 2 === 0 ? '继续写这一幕并保持约束' : '已处理这一轮'}：${'人物关系与伏笔连续性。'.repeat(40)}`,
        createdAt: `2026-07-30T00:00:${String(index).padStart(2, '0')}.000Z`,
    }));
    const waitFor = async (predicate, timeoutMs = 5000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() >= deadline) throw new Error('Timed out waiting for the background rebuild.');
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
    };

    class FakeStore {
        constructor({ conflict = false, snapshotMessages = messages } = {}) {
            this.summary = null;
            this.raw = null;
            this.conflict = conflict;
            this.casCalls = 0;
            this.messages = snapshotMessages;
        }

        token() {
            return Object.freeze({
                rawValue: this.raw,
                version: this.summary?.version ?? null,
                revision: this.summary?.revision ?? null,
                generation: this.summary?.generation ?? null,
                sourceHash: this.summary?.coverage?.sourceHash ?? null,
                dependencyHash: this.summary?.sourceIndex?.dependencyHash ?? null,
            });
        }

        async readCompressionSnapshot() {
            return {
                storageConversationId: 'conversation-1',
                novelId: 'novel-1',
                messages: structuredClone(this.messages),
                artifacts: [],
                authoritativeContext: {
                    currentPlan: null,
                    activeRun: null,
                    pendingUserInput: null,
                    userInputResolutions: [],
                },
                contextSummary: structuredClone(this.summary),
                summaryCasToken: this.token(),
            };
        }

        async compareAndSwapContextSummary(_conversationId, token, nextSummary) {
            this.casCalls += 1;
            if (this.conflict || token.rawValue !== this.raw) return { ok: false, reason: 'conflict' };
            this.summary = structuredClone(nextSummary);
            this.raw = JSON.stringify(nextSummary);
            return { ok: true, summaryCasToken: this.token() };
        }
    }

    function buildResult(prompt) {
        const request = JSON.parse(prompt);
        const projection = structuredClone(request.previousSemanticProjection || emptyProjection());
        const ledger = [];
        for (const message of request.newlyCoveredMessages) {
            if (message.role === 'user') {
                const id = `intent-${message.messageId}`;
                projection.activeIntent.push({
                    id,
                    text: `用户请求 ${message.messageId}`,
                    sourceMessageIds: [message.messageId],
                    authority: 'user',
                    status: 'active',
                });
                ledger.push({
                    messageId: message.messageId,
                    gist: `请求 ${message.messageId}`,
                    classification: 'semantic',
                });
            } else {
                projection.completedOutcomes.push({
                    id: `outcome-${message.messageId}`,
                    text: `助手结果 ${message.messageId}`,
                    sourceMessageIds: [message.messageId],
                    authority: 'assistant',
                    status: 'active',
                });
            }
        }
        projection.activeIntent = projection.activeIntent.slice(-2);
        projection.completedOutcomes = projection.completedOutcomes.slice(-2);
        return JSON.stringify({
            mode: request.mode,
            semanticProjection: projection,
            userMessageLedgerDelta: ledger,
            referencedSources: [],
        });
    }

    function buildProjectResult(prompt) {
        const request = JSON.parse(prompt);
        const result = JSON.parse(buildResult(prompt));
        const source = request.availableSources[0];
        assert.ok(source, 'project compaction should receive the currently available source');
        result.semanticProjection.canonFacts = [{
            id: `project-fact-${source.contentHash}`,
            text: `当前章节来源 ${source.contentHash}`,
            sourceProjectRefs: [source],
            authority: 'project',
            status: 'active',
        }];
        result.referencedSources = [source];
        return JSON.stringify(result);
    }

    const input = (signal) => ({
        storageConversationId: 'conversation-1',
        providerType: 'http',
        model: 'gpt-4.1-mini',
        configuredContextWindowTokens: 8192,
        outputReserveTokens: 1024,
        systemPrompt: 'Return strict JSON.',
        currentRequest: { message: '继续之前的任务' },
        protectedContext: { storageConversationId: 'conversation-1' },
        sections: [],
        signal,
    });
    const directCompactorInput = {
        mode: 'incremental',
        providerType: 'http',
        model: 'gpt-4.1-mini',
        previousProjection: null,
        newlyCoveredMessages: [messages[0]],
        relevantHistoricalMessages: [],
        availableSources: [],
        maxOutputTokens: 512,
        timeoutMs: 1_000,
    };

    for (const invalidText of [
        '',
        'not json',
        '{}',
        JSON.stringify({
            mode: 'rebuild_chunk',
            semanticProjection: emptyProjection(),
            userMessageLedgerDelta: [],
            referencedSources: [],
        }),
        'x'.repeat(513),
    ]) {
        const compactor = new AgentConversationCompactor({
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate() { return { text: invalidText }; },
        });
        await assert.rejects(
            compactor.compact(directCompactorInput),
            (error) => error?.code === 'CONTEXT_COMPACTION_INVALID',
        );
    }

    for (const [message, expectedCode] of [
        ['provider request timeout', 'CONTEXT_COMPACTION_TIMEOUT'],
        ['maximum context length exceeded', 'CONTEXT_COMPACTION_OVERFLOW'],
    ]) {
        const compactor = new AgentConversationCompactor({
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate() { throw new Error(message); },
        });
        await assert.rejects(
            compactor.compact(directCompactorInput),
            (error) => error?.code === expectedCode,
        );
    }

    {
        const store = new FakeStore();
        const providerPrompts = [];
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerPrompts.push(JSON.parse(request.prompt));
                return { text: buildResult(request.prompt) };
            },
        };
        messages.push({
            messageId: 'current-message',
            sequence: 33,
            role: 'user',
            content: '这是本轮必须完整保留的当前请求。',
            createdAt: '2026-07-30T00:00:33.000Z',
        });
        try {
            const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
            const result = await coordinator.prepare({
                ...input(),
                currentRequest: { messageId: 'current-message', content: '这是本轮必须完整保留的当前请求。' },
                currentRequestIdentityRequired: true,
            });
            assert.equal(result.diagnostics.mode, 'semantic');
            assert.equal(result.diagnostics.currentRequestIdentityStatus, 'valid');
            assert.equal(result.diagnostics.currentRequestPayloadOccurrences, 1);
            assert.equal(providerPrompts[0].newlyCoveredMessages.some((item) => item.messageId === 'current-message'), false);
            assert.equal(result.summary.coverage.endMessageId === 'current-message', false);
        } finally {
            messages.pop();
        }
    }

    {
        for (const currentRequest of [
            { content: '缺少 ID' },
            { messageId: 'missing-message', content: '不存在' },
            { messageId: 'm-2', content: messages[1].content },
            { messageId: 'm-1', content: '正文不一致' },
        ]) {
            const store = new FakeStore();
            let providerCalls = 0;
            const coordinator = new AgentContextCompressionCoordinator(store, () => ({
                name: 'http',
                async healthCheck() { return { ok: true }; },
                async generate() {
                    providerCalls += 1;
                    return { text: '{}' };
                },
            }));
            await assert.rejects(
                coordinator.prepare({
                    ...input(),
                    currentRequest,
                    currentRequestIdentityRequired: true,
                }),
                (error) => error?.code === 'CONTEXT_CURRENT_REQUEST_IDENTITY_MISMATCH',
            );
            assert.equal(providerCalls, 0);
            assert.equal(store.casCalls, 0);
        }
    }

    {
        const store = new FakeStore();
        const providerPrompts = [];
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerPrompts.push(request.prompt);
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const first = await coordinator.prepare(input());
        assert.equal(first.diagnostics.mode, 'semantic', JSON.stringify(first.diagnostics));
        assert.equal(first.diagnostics.hardTokenCountMethod, 'conservative_upper_bound');
        assert.match(first.diagnostics.hardTokenCountProfileId, /utf8-upper-v2$/);
        assert.ok(first.diagnostics.preCompressionContextTokens > 0);
        assert.ok(first.diagnostics.preCompressionProviderInputTokens > first.diagnostics.preCompressionContextTokens);
        assert.ok(first.diagnostics.postCompressionProviderInputTokens >= first.diagnostics.postCompressionContextTokens);
        assert.equal(first.diagnostics.rebuildStatus, 'idle');
        assert.equal(first.diagnostics.rebuildTaskId, null);
        assert.deepEqual(first.diagnostics.statusCodes, []);
        assert.equal(first.diagnostics.coverageStartMessageId, first.summary.coverage.startMessageId);
        assert.equal(first.diagnostics.coverageEndMessageId, first.summary.coverage.endMessageId);
        assert.ok(first.diagnostics.recentTailContextTokens > 0);
        assert.ok(first.diagnostics.recentTailUnitCount > 0);
        assert.equal(first.diagnostics.sourceIndexLedgerEntries, first.summary.sourceIndex.userMessageLedger.length);
        assert.ok(first.diagnostics.sourceIndexBytes > 0);
        assert.equal(
            first.diagnostics.semanticLedgerEntries + first.diagnostics.transientLedgerEntries,
            first.diagnostics.sourceIndexLedgerEntries,
        );
        assert.equal(first.diagnostics.compactor.providerType, 'http');
        assert.equal(first.diagnostics.compactor.model, 'gpt-4.1-mini');
        assert.equal(first.diagnostics.compactor.inputTokens, first.diagnostics.compactor.inputBytes);
        assert.equal(first.diagnostics.compactor.outputTokens, first.diagnostics.compactor.outputBytes);
        assert.equal(first.diagnostics.compactor.tokenCountMethod, 'conservative_upper_bound');
        assert.deepEqual(first.diagnostics.qualitySample, {
            reason: 'initial',
            revision: 1,
            generation: 1,
            projectionEntryCount: 2,
            semanticLedgerEntries: 1,
            directlyProjectedSemanticEntries: 1,
            validationPassed: true,
        });
        assert.equal(first.summary.version, 'agent-conversation-summary-v2');
        assert.ok(first.summary.coverage.messageCount > 0);
        assert.equal(store.casCalls, 1);
        const second = await coordinator.prepare({ ...input(), force: true });
        assert.equal(second.diagnostics.mode, 'semantic', JSON.stringify(second.diagnostics));
        const secondPrompt = JSON.parse(providerPrompts[1]);
        assert.equal(Object.hasOwn(secondPrompt, 'userMessageLedger'), false);
        assert.equal(Object.hasOwn(secondPrompt.previousSemanticProjection, 'userMessageLedger'), false);
        assert.ok(secondPrompt.relevantHistoricalMessages.length <= 12);
        assert.ok(secondPrompt.relevantHistoricalMessages.every((message) => message.content.length <= 1_200));

        const originalFirstMessage = messages[0].content;
        messages[0].content = `${originalFirstMessage}（已编辑）`;
        const casCallsBeforeRebuild = store.casCalls;
        const rebuildStarted = await coordinator.prepare(input());
        assert.equal(rebuildStarted.diagnostics.mode, 'degraded', JSON.stringify(rebuildStarted.diagnostics));
        assert.equal(rebuildStarted.diagnostics.triggerReason, 'source_changed');
        assert.equal(rebuildStarted.diagnostics.rebuildStatus, 'running');
        assert.match(rebuildStarted.diagnostics.rebuildTaskId, /^context-rebuild-/);
        assert.equal(rebuildStarted.diagnostics.rebuildCompletedChunks, 0);
        assert.equal(rebuildStarted.diagnostics.rebuildMaxChunks, 24);
        assert.equal(rebuildStarted.diagnostics.rebuildElapsedMs, 0);
        assert.equal(rebuildStarted.diagnostics.rebuildMaxDurationMs, 180_000);
        assert.deepEqual(rebuildStarted.diagnostics.statusCodes, ['CONTEXT_REBUILD_IN_PROGRESS']);
        assert.equal(rebuildStarted.diagnostics.errorCode, undefined);
        assert.equal(rebuildStarted.diagnostics.failureCode, 'CONTEXT_REBUILD_IN_PROGRESS');
        assert.equal(store.casCalls, casCallsBeforeRebuild);
        const rebuilt = await coordinator.prepare({
            ...input(),
            force: true,
            background: true,
            rebuildReason: 'source_changed',
        });
        assert.equal(rebuilt.diagnostics.mode, 'semantic', JSON.stringify(rebuilt.diagnostics));
        assert.equal(rebuilt.diagnostics.rebuildTaskId, rebuildStarted.diagnostics.rebuildTaskId);
        assert.equal(rebuilt.diagnostics.rebuildStatus, 'completed');
        assert.ok(rebuilt.diagnostics.rebuildCompletedChunks > 1);
        assert.equal(rebuilt.diagnostics.rebuildMaxChunks, 24);
        assert.ok(rebuilt.diagnostics.rebuildElapsedMs >= 0);
        assert.deepEqual(rebuilt.diagnostics.statusCodes, []);
        assert.equal(rebuilt.diagnostics.qualitySample.reason, 'rebuild');
        assert.equal(rebuilt.diagnostics.qualitySample.generation, 2);
        await waitFor(() => store.summary?.generation === 2);
        assert.equal(store.casCalls, casCallsBeforeRebuild + 1);
        assert.deepEqual(store.summary.rebuild, { previousGeneration: 1, reason: 'source_changed' });
        const rebuildPrompts = providerPrompts.slice(2).map((prompt) => JSON.parse(prompt));
        assert.ok(rebuildPrompts.length > 1);
        assert.ok(rebuildPrompts.every((prompt) => prompt.mode === 'rebuild_chunk'));
        assert.equal(rebuildPrompts[0].previousSemanticProjection, null);
        assert.ok(rebuildPrompts[1].previousSemanticProjection);
        assert.ok(rebuildPrompts.every((prompt) => !Object.hasOwn(prompt, 'userMessageLedger')));
        messages[0].content = originalFirstMessage;
    }

    {
        const store = new FakeStore();
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) { return { text: buildProjectResult(request.prompt) }; },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const sourceV1 = {
            sourceType: 'chapter',
            sourceId: 'chapter-1',
            sourceVersion: '1',
            contentHash: 'chapter-hash-1',
            title: '人物关系',
        };
        const first = await coordinator.prepare({
            ...input(),
            configuredContextWindowTokens: 131_072,
            force: true,
            availableProjectSources: [sourceV1],
        });
        assert.equal(first.diagnostics.mode, 'semantic');
        const firstRevision = first.summary.revision;
        const firstCoverage = first.summary.coverage.messageCount;
        const sourceV2 = { ...sourceV1, sourceVersion: '2', contentHash: 'chapter-hash-2' };
        const refreshed = await coordinator.prepare({
            ...input(),
            configuredContextWindowTokens: 131_072,
            availableProjectSources: [sourceV2],
        });
        assert.equal(refreshed.diagnostics.triggerReason, 'dependency_changed');
        assert.equal(refreshed.diagnostics.mode, 'semantic');
        assert.equal(refreshed.summary.generation, 1);
        assert.equal(refreshed.summary.revision, firstRevision + 1);
        assert.ok(refreshed.summary.coverage.messageCount >= firstCoverage);
        assert.equal(refreshed.diagnostics.invalidatedSourceCount, 1);
        assert.equal(refreshed.diagnostics.dependencyHashStatus, 'valid');
        assert.equal(refreshed.summary.semanticProjection.canonFacts[0].sourceProjectRefs[0].contentHash, 'chapter-hash-2');
    }

    {
        const store = new FakeStore();
        const prompts = [];
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                prompts.push(JSON.parse(request.prompt));
                return { text: buildProjectResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const sourceV1 = {
            sourceType: 'chapter',
            sourceId: 'chapter-zero-delta',
            sourceVersion: '1',
            contentHash: 'zero-delta-hash-1',
            title: '人物关系',
        };
        const first = await coordinator.prepare({
            ...input(),
            configuredContextWindowTokens: 131_072,
            force: true,
            availableProjectSources: [sourceV1],
        });
        assert.ok(first.summary, JSON.stringify(first.diagnostics));
        const previousCoverage = structuredClone(first.summary.coverage);
        const previousLedger = structuredClone(first.summary.sourceIndex.userMessageLedger);
        store.messages = store.messages.slice(0, first.summary.coverage.messageCount);
        const sourceV2 = { ...sourceV1, sourceVersion: '2', contentHash: 'zero-delta-hash-2' };
        const refreshed = await coordinator.prepare({
            ...input(),
            configuredContextWindowTokens: 131_072,
            availableProjectSources: [sourceV2],
        });
        const refreshPrompt = prompts.at(-1);
        assert.equal(refreshed.diagnostics.operationKind, 'dependency_refresh');
        assert.equal(refreshed.diagnostics.triggerReason, 'dependency_changed');
        assert.equal(refreshed.diagnostics.newlyCoveredMessageCount, 0);
        assert.equal(refreshed.diagnostics.dependencyHashStatus, 'valid');
        assert.deepEqual(refreshPrompt.newlyCoveredMessages, []);
        assert.deepEqual(JSON.parse(buildProjectResult(JSON.stringify(refreshPrompt))).userMessageLedgerDelta, []);
        assert.deepEqual(refreshed.summary.coverage, previousCoverage);
        assert.deepEqual(refreshed.summary.sourceIndex.userMessageLedger, previousLedger);
        assert.equal(refreshed.summary.generation, first.summary.generation);
        assert.equal(refreshed.summary.revision, first.summary.revision + 1);
    }

    {
        const store = new FakeStore();
        const prompts = [];
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                prompts.push(JSON.parse(request.prompt));
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        for (let revision = 0; revision < 8; revision += 1) {
            const result = await coordinator.prepare({ ...input(), force: true });
            assert.equal(result.diagnostics.mode, 'semantic');
            if (result.summary.revision === 5) assert.equal(result.diagnostics.qualitySample.reason, 'periodic');
        }
        assert.ok(store.summary.sourceIndex.userMessageLedger.length >= 8);
        assert.ok(prompts.every((prompt) => !Object.hasOwn(prompt, 'userMessageLedger')));
        assert.ok(prompts.every((prompt) => !Object.hasOwn(prompt.previousSemanticProjection || {}, 'userMessageLedger')));
        assert.ok(prompts.every((prompt) => prompt.relevantHistoricalMessages.length <= 12));
        assert.ok(prompts.every((prompt) => (
            prompt.newlyCoveredMessages.filter((message) => message.role === 'user').length <= 1
        )));
    }

    {
        const store = new FakeStore();
        let providerCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                if (providerCalls === 1) throw new Error('maximum context length exceeded');
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const result = await coordinator.prepare({ ...input(), configuredContextWindowTokens: 32_768 });
        assert.equal(result.diagnostics.mode, 'semantic');
        assert.equal(providerCalls, 2);
        assert.equal(store.casCalls, 1);
    }

    {
        const store = new FakeStore();
        let providerCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(resolve, 35);
                    request.signal?.addEventListener('abort', () => {
                        clearTimeout(timer);
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const firstController = new AbortController();
        const firstWaiter = coordinator.prepare(input(firstController.signal));
        const survivingWaiter = coordinator.prepare(input());
        firstController.abort();
        await assert.rejects(firstWaiter, /cancelled/i);
        const result = await survivingWaiter;
        assert.equal(result.diagnostics.mode, 'semantic');
        assert.equal(result.diagnostics.operationKind, 'coverage_increment');
        assert.equal(providerCalls, 1);
        assert.equal(store.casCalls, 1);
    }

    {
        const store = new FakeStore();
        let providerCalls = 0;
        const firstStarted = Promise.withResolvers();
        const releaseFirst = Promise.withResolvers();
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                if (providerCalls === 1) {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const first = coordinator.prepare({ ...input(), force: true });
        await firstStarted.promise;
        const differentModel = coordinator.prepare({
            ...input(),
            force: true,
            model: 'gpt-4.1',
        });
        releaseFirst.resolve();
        await first;
        const second = await differentModel;
        assert.equal(second.diagnostics.operationKind, 'coverage_increment');
        assert.equal(providerCalls, 2);
        assert.equal(store.casCalls, 2);
    }

    {
        const store = new FakeStore();
        let providerCalls = 0;
        const providerStarted = Promise.withResolvers();
        const releaseProvider = Promise.withResolvers();
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                providerStarted.resolve();
                await releaseProvider.promise;
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const background = coordinator.prepare({ ...input(), force: true, background: true });
        await providerStarted.promise;
        const foreground = await coordinator.prepare(input());
        assert.equal(foreground.diagnostics.failureCode, 'CONTEXT_PRECOMPRESSION_IN_PROGRESS');
        assert.deepEqual(foreground.diagnostics.statusCodes, ['CONTEXT_PRECOMPRESSION_IN_PROGRESS']);
        assert.equal(foreground.diagnostics.errorCode, undefined);
        assert.equal(foreground.diagnostics.rebuildStatus, 'idle');
        assert.equal(foreground.diagnostics.rebuildTaskId, null);
        assert.equal(foreground.diagnostics.mode, 'degraded');
        assert.equal(providerCalls, 1);
        assert.equal(store.casCalls, 0);
        releaseProvider.resolve();
        const completed = await background;
        assert.equal(completed.diagnostics.mode, 'semantic');
        assert.equal(providerCalls, 1);
        assert.equal(store.casCalls, 1);
    }

    {
        const store = new FakeStore();
        let providerAborted = false;
        let providerCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                await new Promise((_resolve, reject) => {
                    request.signal?.addEventListener('abort', () => {
                        providerAborted = true;
                        const error = new Error('aborted');
                        error.name = 'AbortError';
                        reject(error);
                    }, { once: true });
                });
                return { text: '{}' };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const controller = new AbortController();
        const waiter = coordinator.prepare(input(controller.signal));
        controller.abort();
        await assert.rejects(waiter, /cancelled/i);
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(providerCalls === 0 || providerAborted, true);
        assert.equal(store.casCalls, 0);
    }

    {
        const store = new FakeStore();
        let providerCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate() {
                providerCalls += 1;
                return { text: '{}' };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        for (let attempt = 1; attempt <= 3; attempt += 1) {
            const result = await coordinator.prepare(input());
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.consecutiveFailures, attempt);
        }
        const openCircuit = await coordinator.prepare(input());
        assert.equal(openCircuit.diagnostics.circuitOpen, true);
        assert.equal(openCircuit.diagnostics.failureCode, 'CONTEXT_COMPACTION_CIRCUIT_OPEN');
        assert.equal(openCircuit.diagnostics.errorCode, 'CONTEXT_COMPACTION_CIRCUIT_OPEN');
        assert.deepEqual(openCircuit.diagnostics.statusCodes, []);
        assert.equal(providerCalls, 3);
    }

    {
        const store = new FakeStore({ conflict: true });
        let providerCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                providerCalls += 1;
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        const result = await coordinator.prepare(input());
        assert.equal(result.diagnostics.mode, 'degraded');
        assert.equal(result.diagnostics.casConflict, true);
        assert.equal(providerCalls, 1);
    }

    {
        const originalFirstMessage = messages[0].content;
        const store = new FakeStore();
        let rebuildCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                const parsed = JSON.parse(request.prompt);
                if (parsed.mode === 'rebuild_chunk') rebuildCalls += 1;
                if (parsed.mode === 'rebuild_chunk' && rebuildCalls === 2) {
                    return {
                        text: JSON.stringify({
                            ...JSON.parse(buildResult(request.prompt)),
                            userMessageLedgerDelta: [],
                        }),
                    };
                }
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        await coordinator.prepare(input());
        const casCallsBeforeRebuild = store.casCalls;
        messages[0].content = `${originalFirstMessage}（无效分块测试）`;
        try {
            const result = await coordinator.prepare({
                ...input(),
                force: true,
                background: true,
                rebuildReason: 'source_changed',
            });
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.failureCode, 'CONTEXT_COMPACTION_INVALID');
            assert.equal(result.diagnostics.errorCode, 'CONTEXT_COMPACTION_INVALID');
            assert.equal(result.diagnostics.rebuildStatus, 'discarded');
            assert.equal(rebuildCalls, 2);
            assert.equal(store.casCalls, casCallsBeforeRebuild);
            assert.equal(store.summary.generation, 1);
        } finally {
            messages[0].content = originalFirstMessage;
        }
    }

    for (const boundary of [
        { turns: 29, expectedChunks: 24, shouldComplete: true },
        { turns: 30, expectedChunks: 24, shouldComplete: false },
    ]) {
        const boundaryMessages = Array.from({ length: boundary.turns * 2 }, (_, index) => ({
            messageId: `boundary-${boundary.turns}-${index + 1}`,
            sequence: index + 1,
            role: index % 2 === 0 ? 'user' : 'assistant',
            content: `${index % 2 === 0 ? '保持人物动机与伏笔' : '已完成当前回合'}：${'连续原子单元内容。'.repeat(40)}`,
            createdAt: `2026-07-30T00:00:${String(index).padStart(2, '0')}.000Z`,
        }));
        const store = new FakeStore({ snapshotMessages: boundaryMessages });
        let rebuildCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                if (JSON.parse(request.prompt).mode === 'rebuild_chunk') rebuildCalls += 1;
                const result = JSON.parse(buildResult(request.prompt));
                result.semanticProjection = emptyProjection();
                return { text: JSON.stringify(result) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        await coordinator.prepare(input());
        const generationBefore = store.summary.generation;
        const casCallsBefore = store.casCalls;
        boundaryMessages[0].content += '（来源已编辑）';
        const result = await coordinator.prepare({
            ...input(),
            force: true,
            background: true,
            rebuildReason: 'source_changed',
        });
        assert.equal(rebuildCalls, boundary.expectedChunks, JSON.stringify(result.diagnostics));
        assert.equal(result.diagnostics.rebuildCompletedChunks, boundary.expectedChunks);
        assert.equal(result.diagnostics.rebuildMaxChunks, 24);
        if (boundary.shouldComplete) {
            assert.equal(result.diagnostics.mode, 'semantic');
            assert.equal(result.diagnostics.rebuildStatus, 'completed');
            assert.equal(store.summary.generation, generationBefore + 1);
            assert.equal(store.casCalls, casCallsBefore + 1);
        } else {
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.rebuildStatus, 'limit_exceeded');
            assert.equal(result.diagnostics.errorCode, 'CONTEXT_COMPACTION_REBUILD_LIMIT');
            assert.equal(store.summary.generation, generationBefore);
            assert.equal(store.casCalls, casCallsBefore);
        }
    }

    {
        const originalFirstMessage = messages[0].content;
        const store = new FakeStore();
        let rebuildCalls = 0;
        const secondChunkStarted = Promise.withResolvers();
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                const parsed = JSON.parse(request.prompt);
                if (parsed.mode !== 'rebuild_chunk') return { text: buildResult(request.prompt) };
                rebuildCalls += 1;
                if (rebuildCalls === 2) {
                    secondChunkStarted.resolve();
                    await new Promise((_resolve, reject) => {
                        request.signal?.addEventListener('abort', () => {
                            const error = new Error('aborted');
                            error.name = 'AbortError';
                            reject(error);
                        }, { once: true });
                    });
                }
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        await coordinator.prepare(input());
        const casCallsBeforeRebuild = store.casCalls;
        messages[0].content = `${originalFirstMessage}（取消测试）`;
        const controller = new AbortController();
        try {
            const rebuild = coordinator.prepare({
                ...input(controller.signal),
                force: true,
                background: true,
                rebuildReason: 'source_changed',
            });
            await secondChunkStarted.promise;
            const observerOne = await coordinator.prepare(input());
            const observerTwo = await coordinator.prepare(input());
            assert.equal(observerOne.diagnostics.rebuildStatus, 'running');
            assert.equal(observerOne.diagnostics.rebuildCompletedChunks, 1);
            assert.equal(observerOne.diagnostics.rebuildTaskId, observerTwo.diagnostics.rebuildTaskId);
            assert.equal(observerOne.diagnostics.rebuildMaxChunks, observerTwo.diagnostics.rebuildMaxChunks);
            assert.equal(observerOne.diagnostics.rebuildMaxDurationMs, observerTwo.diagnostics.rebuildMaxDurationMs);
            assert.ok(observerTwo.diagnostics.rebuildElapsedMs >= observerOne.diagnostics.rebuildElapsedMs);
            controller.abort();
            await assert.rejects(rebuild, /cancelled/i);
            assert.equal(store.casCalls, casCallsBeforeRebuild);
            assert.equal(store.summary.generation, 1);
        } finally {
            messages[0].content = originalFirstMessage;
        }
    }

    {
        const originalFirstMessage = messages[0].content;
        const store = new FakeStore();
        let rebuildCalls = 0;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                const parsed = JSON.parse(request.prompt);
                if (parsed.mode === 'rebuild_chunk') {
                    rebuildCalls += 1;
                    if (rebuildCalls === 2) messages[0].content += '（重建期间再次编辑）';
                }
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        await coordinator.prepare(input());
        const casCallsBeforeRebuild = store.casCalls;
        messages[0].content = `${originalFirstMessage}（来源变化测试）`;
        try {
            const result = await coordinator.prepare({
                ...input(),
                force: true,
                background: true,
                rebuildReason: 'source_changed',
            });
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.casConflict, true);
            assert.equal(result.diagnostics.failureCode, 'CONTEXT_COMPACTION_CONFLICT');
            assert.equal(result.diagnostics.errorCode, 'CONTEXT_COMPACTION_CONFLICT');
            assert.equal(result.diagnostics.rebuildStatus, 'discarded');
            assert.equal(store.casCalls, casCallsBeforeRebuild);
            assert.equal(store.summary.generation, 1);
        } finally {
            messages[0].content = originalFirstMessage;
        }
    }

    {
        const originalFirstMessage = messages[0].content;
        const store = new FakeStore();
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) { return { text: buildResult(request.prompt) }; },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider, {
            maxRebuildChunks: 1,
        });
        await coordinator.prepare(input());
        const casCallsBeforeRebuild = store.casCalls;
        messages[0].content = `${originalFirstMessage}（分块上限测试）`;
        try {
            const result = await coordinator.prepare({
                ...input(),
                force: true,
                background: true,
                rebuildReason: 'source_changed',
            });
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.failureCode, 'CONTEXT_COMPACTION_REBUILD_LIMIT');
            assert.equal(result.diagnostics.errorCode, 'CONTEXT_COMPACTION_REBUILD_LIMIT');
            assert.equal(result.diagnostics.rebuildStatus, 'limit_exceeded');
            assert.equal(result.diagnostics.rebuildCompletedChunks, 1);
            assert.equal(result.diagnostics.rebuildMaxChunks, 1);
            assert.equal(result.diagnostics.rebuildChunksCompleted, 1);
            assert.equal(store.casCalls, casCallsBeforeRebuild);
            assert.equal(store.summary.generation, 1);
        } finally {
            messages[0].content = originalFirstMessage;
        }
    }

    {
        const originalFirstMessage = messages[0].content;
        const store = new FakeStore();
        let rebuildCalls = 0;
        let clock = 1_000_000;
        const realNow = Date.now;
        const provider = {
            name: 'http',
            async healthCheck() { return { ok: true }; },
            async generate(request) {
                const parsed = JSON.parse(request.prompt);
                if (parsed.mode === 'rebuild_chunk') {
                    rebuildCalls += 1;
                    clock += 180_001;
                }
                return { text: buildResult(request.prompt) };
            },
        };
        const coordinator = new AgentContextCompressionCoordinator(store, () => provider);
        await coordinator.prepare(input());
        const casCallsBeforeRebuild = store.casCalls;
        messages[0].content = `${originalFirstMessage}（总时限测试）`;
        Date.now = () => clock;
        try {
            const result = await coordinator.prepare({
                ...input(),
                force: true,
                background: true,
                rebuildReason: 'source_changed',
            });
            assert.equal(result.diagnostics.mode, 'degraded');
            assert.equal(result.diagnostics.failureCode, 'CONTEXT_COMPACTION_REBUILD_LIMIT');
            assert.equal(result.diagnostics.errorCode, 'CONTEXT_COMPACTION_REBUILD_LIMIT');
            assert.equal(result.diagnostics.rebuildStatus, 'limit_exceeded');
            assert.equal(result.diagnostics.rebuildCompletedChunks, 1);
            assert.equal(result.diagnostics.rebuildElapsedMs, 180_001);
            assert.equal(result.diagnostics.rebuildMaxDurationMs, 180_000);
            assert.equal(rebuildCalls, 1);
            assert.equal(store.casCalls, casCallsBeforeRebuild);
            assert.equal(store.summary.generation, 1);
        } finally {
            Date.now = realNow;
            messages[0].content = originalFirstMessage;
        }
    }

    console.log('Agent context compression coordinator tests passed.');
} finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
}
