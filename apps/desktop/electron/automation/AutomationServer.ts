import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AutomationService } from './AutomationService';
import type { AutomationEnvelope, AutomationErrorShape } from './types';
import { devLog, devLogError, redactForLog } from '../debug/devLogger';

type RuntimeDescriptor = {
    version: 1;
    port: number;
    token: string;
    pid: number;
    startedAt: string;
};

export class AutomationServer {
    private readonly automationService: AutomationService;
    private readonly getUserDataPath: () => string;
    private readonly onDataChanged?: (method: string) => void;
    private server: http.Server | null = null;
    private runtime: RuntimeDescriptor | null = null;
    private readonly activeRequests = new Map<string, AbortController>();

    constructor(
        automationService: AutomationService,
        getUserDataPath: () => string,
        onDataChanged?: (method: string) => void,
    ) {
        this.automationService = automationService;
        this.getUserDataPath = getUserDataPath;
        this.onDataChanged = onDataChanged;
    }

    private notifyDataChanged(method: string): void {
        const dataChangingMethods = new Set([
            'outline.write',
            'character.create_batch',
            'story_patch.apply',
            'worldsetting.create',
            'worldsetting.update',
            'chapter.create',
            'chapter.save',
            'creative_assets.generate_draft',
            'creative_assets.revise_draft',
            'creative_assets.validate_draft',
            'outline.generate_draft',
            'chapter.draft.start',
            'chapter.draft.cancel',
            'chapter.draft.retry',
            'chapter.revise_draft',
            'draft.update',
            'draft.commit',
            'draft.undo',
            'draft.discard',
            'draft.batch.create',
            'draft.batch.update_outline',
            'draft.batch.approve_outline',
            'draft.batch.attach_child',
            'draft.batch.mark_stale_after',
            'draft.batch.prepare_regeneration',
            'draft.batch.mark_failed',
            'draft.batch.reconcile_unknown',
            'draft.batch.commit_prefix',
            'draft.batch.undo',
            'draft.batch.discard',
            'artifact.review.submit',
            'revision_task.create_plan',
        ]);
        if (dataChangingMethods.has(method)) {
            this.onDataChanged?.(method);
        }
    }

    private getAutomationDir(): string {
        return path.join(this.getUserDataPath(), 'automation');
    }

    private getRuntimePath(): string {
        return path.join(this.getAutomationDir(), 'runtime.json');
    }

    private async writeRuntime(): Promise<void> {
        if (!this.runtime) return;
        await fs.mkdir(this.getAutomationDir(), { recursive: true });
        await fs.writeFile(this.getRuntimePath(), JSON.stringify(this.runtime, null, 2), 'utf8');
    }

    private async removeRuntime(): Promise<void> {
        try {
            await fs.unlink(this.getRuntimePath());
        } catch (error: any) {
            if (error?.code !== 'ENOENT') {
                throw error;
            }
        }
    }

    private sendJson<T>(res: ServerResponse, statusCode: number, payload: AutomationEnvelope<T>): void {
        const body = JSON.stringify(payload);
        res.writeHead(statusCode, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body, 'utf8'),
        });
        res.end(body);
    }

    private async readJson(req: IncomingMessage): Promise<any> {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks).toString('utf8');
        return body ? JSON.parse(body) : {};
    }

    private normalizeError(error: any): AutomationErrorShape {
        return {
            code: error?.code || 'INTERNAL_ERROR',
            message: error?.message || 'Internal automation error',
            details: error?.details,
        };
    }

    private isAuthorized(req: IncomingMessage): boolean {
        if (!this.runtime) return false;
        const auth = req.headers.authorization || '';
        return auth === `Bearer ${this.runtime.token}`;
    }

    async start(): Promise<void> {
        if (this.server) return;
        this.runtime = {
            version: 1,
            port: 0,
            token: randomUUID(),
            pid: process.pid,
            startedAt: new Date().toISOString(),
        };

        this.server = http.createServer(async (req, res) => {
            try {
                if (req.url === '/health') {
                    this.sendJson(res, 200, { ok: true, code: 'OK', message: 'healthy', data: { pid: process.pid } });
                    return;
                }

                if (!this.isAuthorized(req)) {
                    this.sendJson(res, 401, { ok: false, code: 'UNAUTHORIZED', message: 'Unauthorized' });
                    return;
                }

                if (req.method === 'POST' && req.url === '/invoke') {
                    const payload = await this.readJson(req);
                    const requestId = typeof payload.requestId === 'string' && payload.requestId.trim()
                        ? payload.requestId.trim()
                        : randomUUID();
                    const startedAt = Date.now();
                    devLog('INFO', 'AutomationServer.invoke.start', 'Automation HTTP invoke start', {
                        requestId,
                        method: payload.method,
                        origin: payload.origin ?? 'mcp-bridge',
                        params: redactForLog(payload.params),
                    });
                    const controller = new AbortController();
                    this.activeRequests.set(requestId, controller);
                    let data: unknown;
                    try {
                        data = await this.automationService.invoke(payload.method, payload.params, {
                            source: 'http',
                            origin: payload.origin ?? 'mcp-bridge',
                            requestId,
                            parentRequestId: typeof payload.parentRequestId === 'string' ? payload.parentRequestId : undefined,
                            deadlineAt: typeof payload.deadlineAt === 'string' ? payload.deadlineAt : undefined,
                            signal: controller.signal,
                        });
                    } finally {
                        if (this.activeRequests.get(requestId) === controller) {
                            this.activeRequests.delete(requestId);
                        }
                    }
                    devLog('INFO', 'AutomationServer.invoke.success', 'Automation HTTP invoke success', {
                        requestId,
                        method: payload.method,
                        elapsedMs: Date.now() - startedAt,
                        result: redactForLog(data),
                    });
                    this.notifyDataChanged(String(payload.method || ''));
                    this.sendJson(res, 200, { ok: true, code: 'OK', message: 'ok', data });
                    return;
                }

                if (req.method === 'POST' && req.url === '/cancel') {
                    const payload = await this.readJson(req);
                    const requestId = typeof payload.requestId === 'string' ? payload.requestId.trim() : '';
                    if (!requestId) {
                        this.sendJson(res, 400, { ok: false, code: 'INVALID_INPUT', message: 'requestId is required' });
                        return;
                    }
                    const controller = this.activeRequests.get(requestId);
                    controller?.abort(new Error('Automation request cancelled'));
                    this.sendJson(res, 200, {
                        ok: true,
                        code: 'OK',
                        message: controller ? 'cancelled' : 'request not active',
                        data: { requestId, cancelled: Boolean(controller) },
                    });
                    return;
                }

                this.sendJson(res, 404, { ok: false, code: 'NOT_FOUND', message: 'Not found' });
            } catch (error) {
                const normalized = this.normalizeError(error);
                devLogError('AutomationServer.invoke.error', error, {
                    url: req.url,
                    method: req.method,
                });
                this.sendJson(res, 500, {
                    ok: false,
                    code: normalized.code,
                    message: normalized.message,
                    data: normalized.details,
                });
            }
        });

        await new Promise<void>((resolve, reject) => {
            this.server!.once('error', reject);
            this.server!.listen(0, '127.0.0.1', () => resolve());
        });
        const address = this.server.address();
        if (!address || typeof address === 'string') {
            throw new Error('Failed to resolve automation server port');
        }
        this.runtime.port = address.port;
        await this.writeRuntime();
    }

    async stop(): Promise<void> {
        await this.automationService.shutdown();
        for (const controller of this.activeRequests.values()) {
            controller.abort(new Error('Automation server stopped'));
        }
        this.activeRequests.clear();
        await this.removeRuntime();
        if (!this.server) return;
        await new Promise<void>((resolve, reject) => {
            this.server!.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });
        this.server = null;
        this.runtime = null;
    }
}
