import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { devLog, devLogError, redactForLog } from '../debug/devLogger';
import { subscribeAgentRunEventsHttp, type AgentRunEvent } from './agentSseClient';
import {
    AGENT_RUNTIME_RECOVERY_BACKOFF_MS,
    recordRuntimeHealthFailure,
    type AgentRuntimeAvailability,
} from './runtimeHealthPolicy';

export type AgentRuntimeHealth = {
    ok: boolean;
    code?: string;
    message?: string;
    data?: unknown;
};

type AgentRuntimePhase =
    | 'idle'
    | 'starting_python'
    | 'loading_modules'
    | 'loading_web_server'
    | 'loading_graph_engine'
    | 'loading_tool_protocol'
    | 'loading_runtime'
    | 'initializing_state'
    | 'loading_tools'
    | 'restoring_state'
    | 'starting_server'
    | 'ready'
    | 'failed';

type AgentInvokeEnvelope = {
    requestId?: string;
    method: string;
    params?: Record<string, unknown>;
    context?: Record<string, unknown>;
};

export type AgentChatProgress = {
    sequence: number;
    phase: 'thinking' | 'reading' | 'extending' | 'finalizing' | 'cancelled';
    toolName?: string;
    attachmentId?: string;
    selector?: unknown;
    [key: string]: unknown;
};

type PythonRuntimeClientOptions = {
    getUserDataPath: () => string;
    getAutomationRuntimePath: () => string;
    isPackaged: boolean;
};

type RuntimeRecoveryOptions = {
    kind: 'initial' | 'automatic' | 'request' | 'manual' | 'connection';
    forceRestart: boolean;
    allowAutomaticRetry: boolean;
    delayMs?: number;
    failedPort?: number;
};

const AGENT_RUNTIME_STARTUP_TIMEOUT_MS = 60_000;
const AGENT_RUNTIME_HEALTH_POLL_MS = 500;
const AGENT_RUNTIME_STARTUP_PROGRESS_LOG_MS = 15_000;
const AGENT_RUNTIME_PROGRESS_PREFIX = '@@NOVEL_AGENT_PROGRESS@@';
const AGENT_RUNTIME_PHASES = new Set<AgentRuntimePhase>([
    'idle',
    'starting_python',
    'loading_modules',
    'loading_web_server',
    'loading_graph_engine',
    'loading_tool_protocol',
    'loading_runtime',
    'initializing_state',
    'loading_tools',
    'restoring_state',
    'starting_server',
    'ready',
    'failed',
]);

function resolveRepoRoot(): string {
    if (process.env.APP_ROOT) {
        return path.resolve(process.env.APP_ROOT, '../..');
    }
    return process.cwd();
}

function getFreePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => {
                if (!address || typeof address === 'string') {
                    reject(new Error('Failed to resolve free port'));
                    return;
                }
                resolve(address.port);
            });
        });
    });
}

function createRuntimePortError(port: number): Error {
    return Object.assign(new Error(`Agent runtime port unavailable: ${port}`), {
        code: 'AGENT_RUNTIME_PORT_UNAVAILABLE',
    });
}

function assertRuntimePort(port: number): void {
    if (!Number.isInteger(port) || port <= 0) {
        throw createRuntimePortError(port);
    }
}

function requestJson(port: number, pathName: string, token: string, payload?: unknown, timeoutMs = 8000): Promise<AgentRuntimeHealth> {
    assertRuntimePort(port);
    const body = payload ? JSON.stringify(payload) : '';
    return new Promise((resolve, reject) => {
        const request = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path: pathName,
                method: payload ? 'POST' : 'GET',
                headers: {
                    ...(payload ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(body, 'utf8'),
                    } : {}),
                    ...(token ? { Authorization: `Bearer ${token}` } : {}),
                },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                response.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    try {
                        resolve(text ? JSON.parse(text) : { ok: false, code: 'EMPTY_RESPONSE', message: 'Empty response' });
                    } catch (error: any) {
                        reject(new Error(`Agent response parse failed: ${error?.message || 'unknown error'}`));
                    }
                });
            },
        );
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Agent runtime request timeout')));
        request.on('error', reject);
        if (body) request.write(body);
        request.end();
    });
}

function isRecoverableRuntimeConnectionError(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
    return ['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'AGENT_RUNTIME_PORT_UNAVAILABLE'].includes(code);
}

function getConnectionErrorPort(error: unknown): number {
    if (typeof error !== 'object' || error === null || !('port' in error)) {
        return 0;
    }
    const port = Number((error as { port?: unknown }).port);
    return Number.isInteger(port) && port > 0 ? port : 0;
}

export class PythonRuntimeClient {
    private readonly getUserDataPath: () => string;
    private readonly getAutomationRuntimePath: () => string;
    private readonly isPackaged: boolean;
    private process: ChildProcessWithoutNullStreams | null = null;
    private port = 0;
    private token = '';
    private startPromise: Promise<void> | null = null;
    private recoveryPromise: Promise<AgentRuntimeHealth> | null = null;
    private disabledReason: string | null = null;
    private phase: AgentRuntimePhase = 'idle';
    private availability: AgentRuntimeAvailability = 'starting';
    private consecutiveHealthFailures = 0;
    private activeInvocations = 0;
    private autoRestartAttempted = false;
    private startupStartedAt = 0;
    private phaseChangedAt = Date.now();
    private lastStartupError = '';

    constructor(options: PythonRuntimeClientOptions) {
        this.getUserDataPath = options.getUserDataPath;
        this.getAutomationRuntimePath = options.getAutomationRuntimePath;
        this.isPackaged = options.isPackaged;
    }

    prewarm(): void {
        devLog('INFO', 'PythonRuntimeClient.prewarm', 'Prewarming Python Agent runtime in background');
        this.startInBackground();
    }

    async health(): Promise<AgentRuntimeHealth> {
        if (this.recoveryPromise || this.startPromise) {
            return this.statusSnapshot();
        }
        if (this.availability === 'failed') {
            return this.statusSnapshot();
        }
        if (this.phase !== 'ready' || !this.process || this.port <= 0) {
            this.startInBackground();
            return this.statusSnapshot();
        }
        try {
            const response = await requestJson(this.port, '/health', this.token, undefined, 2000);
            if (!response.ok) {
                throw Object.assign(new Error(response.message || 'Agent runtime health check failed'), {
                    code: response.code || 'AGENT_RUNTIME_HEALTH_FAILED',
                });
            }
            this.markHealthy();
            return {
                ...response,
                data: {
                    ...(response.data && typeof response.data === 'object' ? response.data : {}),
                    ...this.statusData(),
                },
            };
        } catch (error) {
            return this.recordHealthProbeFailure(error);
        }
    }

    private startInBackground(): void {
        if (this.availability === 'failed') return;
        if (this.startPromise || this.recoveryPromise) return;
        void this.beginRecovery({ kind: 'initial', forceRestart: false, allowAutomaticRetry: true });
    }

    private recordHealthProbeFailure(error: unknown): AgentRuntimeHealth {
        const message = error instanceof Error ? error.message : String(error);
        this.lastStartupError = message;
        const decision = recordRuntimeHealthFailure({
            consecutiveFailures: this.consecutiveHealthFailures,
            activeInvocations: this.activeInvocations,
            autoRestartAttempted: this.autoRestartAttempted,
        });
        this.consecutiveHealthFailures = decision.consecutiveFailures;
        this.availability = decision.availability;
        devLog('WARN', 'PythonRuntimeClient.health.slow', 'Agent runtime health probe failed', {
            consecutiveFailures: this.consecutiveHealthFailures,
            activeInvocations: this.activeInvocations,
            shouldAutoRestart: decision.shouldAutoRestart,
            error: message,
        });
        if (decision.shouldAutoRestart) {
            this.autoRestartAttempted = true;
            void this.beginRecovery({
                kind: 'automatic',
                forceRestart: true,
                allowAutomaticRetry: false,
                delayMs: AGENT_RUNTIME_RECOVERY_BACKOFF_MS,
            });
        }
        return this.statusSnapshot();
    }

    private statusData(): Record<string, unknown> {
        const now = Date.now();
        return {
            phase: this.phase,
            elapsedMs: this.startupStartedAt > 0 ? Math.max(0, now - this.startupStartedAt) : 0,
            phaseElapsedMs: Math.max(0, now - this.phaseChangedAt),
            port: this.phase === 'ready' ? this.port : undefined,
            availability: this.availability,
            consecutiveHealthFailures: this.consecutiveHealthFailures,
            activeInvocations: this.activeInvocations,
            autoRestartAttempted: this.autoRestartAttempted,
            recovering: this.availability === 'recovering',
            canManualRetry: this.availability === 'failed',
        };
    }

    private statusSnapshot(): AgentRuntimeHealth {
        const isAvailable = this.availability === 'ready' || this.availability === 'slow';
        let code: string | undefined;
        let message: string;
        switch (this.availability) {
            case 'ready':
                message = 'Agent runtime is ready';
                break;
            case 'slow':
                code = 'AGENT_RUNTIME_SLOW';
                message = this.lastStartupError || 'Agent runtime is responding slowly';
                break;
            case 'recovering':
                code = 'AGENT_RUNTIME_RECOVERING';
                message = 'Agent runtime is recovering';
                break;
            case 'failed':
                code = 'AGENT_RUNTIME_UNAVAILABLE';
                message = this.lastStartupError || this.disabledReason || 'Agent runtime unavailable';
                break;
            default:
                code = 'AGENT_RUNTIME_STARTING';
                message = 'Agent runtime is starting';
        }
        return {
            ok: isAvailable,
            ...(code ? { code } : {}),
            message,
            data: this.statusData(),
        };
    }

    private markHealthy(): void {
        this.availability = 'ready';
        this.consecutiveHealthFailures = 0;
        this.autoRestartAttempted = false;
        this.disabledReason = null;
        this.lastStartupError = '';
        if (this.phase !== 'ready') this.setPhase('ready');
    }

    private setPhase(phase: AgentRuntimePhase, error = ''): void {
        if (phase === 'starting_python' && this.phase !== 'starting_python') {
            this.startupStartedAt = Date.now();
            this.lastStartupError = '';
        }
        if (phase === 'failed') {
            this.availability = 'failed';
        }
        if (this.phase !== phase) {
            const previousPhase = this.phase;
            this.phase = phase;
            this.phaseChangedAt = Date.now();
            devLog(
                phase === 'failed' ? 'ERROR' : 'INFO',
                'PythonRuntimeClient.phase',
                'Agent runtime phase changed',
                {
                    previousPhase,
                    phase,
                    elapsedMs: this.startupStartedAt > 0 ? Date.now() - this.startupStartedAt : 0,
                },
            );
        }
        if (error) {
            this.lastStartupError = error;
            this.disabledReason = error;
        } else if (phase === 'ready') {
            this.availability = 'ready';
            this.consecutiveHealthFailures = 0;
            this.autoRestartAttempted = false;
            this.disabledReason = null;
            this.lastStartupError = '';
        }
    }

    private applyProgressLine(line: string): boolean {
        if (!line.startsWith(AGENT_RUNTIME_PROGRESS_PREFIX)) return false;
        try {
            const payload = JSON.parse(line.slice(AGENT_RUNTIME_PROGRESS_PREFIX.length)) as { phase?: unknown };
            const phase = String(payload.phase || '') as AgentRuntimePhase;
            if (AGENT_RUNTIME_PHASES.has(phase)) {
                this.setPhase(phase);
            }
        } catch (error) {
            devLog('WARN', 'PythonRuntimeClient.progress.parse', 'Failed to parse Agent runtime startup progress', {
                line,
                error: error instanceof Error ? error.message : String(error),
            });
        }
        return true;
    }

    async invoke(envelope: AgentInvokeEnvelope, onProgress?: (progress: AgentChatProgress) => void): Promise<unknown> {
        this.activeInvocations += 1;
        try {
            const health = await this.ensureReady();
            if (!health.ok) {
                throw Object.assign(new Error(health.message || 'Agent runtime unavailable'), {
                    code: health.code || 'AGENT_RUNTIME_UNAVAILABLE',
                    details: health.data,
                });
            }
            try {
                return await this.invokeOnce(envelope, onProgress);
            } catch (error) {
                if (!isRecoverableRuntimeConnectionError(error)) {
                    throw error;
                }
                const failedPort = getConnectionErrorPort(error);
                devLog('WARN', 'PythonRuntimeClient.invoke.retry', 'Agent runtime connection failed; recovering once', {
                    error: error instanceof Error ? error.message : String(error),
                    port: this.port,
                    failedPort,
                });
                const recovered = await this.beginRecovery({
                    kind: 'connection',
                    forceRestart: true,
                    allowAutomaticRetry: false,
                    failedPort,
                });
                if (!recovered.ok) {
                    throw Object.assign(new Error(recovered.message || 'Agent runtime recovery failed'), {
                        code: recovered.code || 'AGENT_RUNTIME_UNAVAILABLE',
                        details: recovered.data,
                    });
                }
                return this.invokeOnce(envelope, onProgress);
            }
        } finally {
            this.activeInvocations = Math.max(0, this.activeInvocations - 1);
        }
    }

    private async invokeOnce(envelope: AgentInvokeEnvelope, onProgress?: (progress: AgentChatProgress) => void): Promise<unknown> {
        const port = this.port;
        const token = this.token;
        const requestId = envelope.requestId || randomUUID();
        let lastSequence = 0;
        let polling = false;
        const pollProgress = async () => {
            if (!onProgress || polling) return;
            polling = true;
            try {
                const snapshot = await requestJson(port, `/progress/${encodeURIComponent(requestId)}?afterSequence=${lastSequence}`, token, undefined, 2000);
                const events = (snapshot.data as { events?: AgentChatProgress[] } | undefined)?.events || [];
                for (const progress of events) {
                    if (Number(progress.sequence) > lastSequence) {
                        lastSequence = Number(progress.sequence);
                        onProgress(progress);
                    }
                }
            } catch {
                // Progress is advisory; the invoke response remains authoritative.
            } finally {
                polling = false;
            }
        };
        const timer = onProgress ? setInterval(() => void pollProgress(), 300) : undefined;
        try {
            const response = await requestJson(
                port,
                '/invoke',
                token,
                {
                requestId,
                method: envelope.method,
                params: envelope.params || {},
                context: envelope.context || {},
                },
                180000,
            );
            if (timer) clearInterval(timer);
            while (polling) {
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await pollProgress();
            this.markHealthy();
            if (!response.ok) {
                throw Object.assign(new Error(response.message || 'Agent runtime failed'), {
                    code: response.code || 'AGENT_RUNTIME_ERROR',
                    details: response.data,
                });
            }
            return response.data;
        } finally {
            if (timer) clearInterval(timer);
        }
    }

    async cancelRequest(requestId: string): Promise<boolean> {
        const normalized = String(requestId || '').trim();
        if (!normalized || this.port <= 0) return false;
        const response = await requestJson(
            this.port,
            '/cancel',
            this.token,
            { requestId: normalized },
            10000,
        );
        return Boolean(response.ok && (response.data as { cancelled?: unknown } | undefined)?.cancelled);
    }

    async subscribeRunEvents(
        runId: string,
        options: { afterSequence?: number },
        onEvent: (event: AgentRunEvent) => void,
        onDisconnect: (payload: { runId: string; message: string }) => void,
    ): Promise<() => void> {
        const health = await this.ensureReady();
        if (!health.ok) {
            throw Object.assign(new Error(health.message || 'Agent runtime unavailable'), {
                code: health.code || 'AGENT_RUNTIME_UNAVAILABLE',
                details: health.data,
            });
        }
        const port = this.port;
        const token = this.token;
        assertRuntimePort(port);
        this.activeInvocations += 1;
        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            this.activeInvocations = Math.max(0, this.activeInvocations - 1);
        };
        try {
            const unsubscribe = subscribeAgentRunEventsHttp({
                port,
                token,
                runId,
                afterSequence: options.afterSequence,
                onEvent,
                onDisconnect: (payload) => {
                    release();
                    onDisconnect(payload);
                },
                onParseError: (error) => {
                    devLog('WARN', 'PythonRuntimeClient.sse.parse', 'Failed to parse Agent SSE event', {
                        runId,
                        error: error instanceof Error ? error.message : String(error),
                    });
                },
            });
            this.markHealthy();
            return () => {
                release();
                unsubscribe();
            };
        } catch (error) {
            release();
            throw error;
        }
    }

    async stop(): Promise<void> {
        this.port = 0;
        this.token = '';
        if (!this.process) return;
        const child = this.process;
        this.process = null;
        child.kill();
    }

    async ensureReady(): Promise<AgentRuntimeHealth> {
        if (this.recoveryPromise) return this.recoveryPromise;
        if (
            this.phase === 'ready'
            && this.process
            && this.port > 0
            && (this.availability === 'ready' || this.availability === 'slow')
        ) {
            return this.statusSnapshot();
        }
        return this.beginRecovery({
            kind: 'request',
            forceRestart: Boolean(this.process || this.port > 0 || this.availability === 'failed'),
            allowAutomaticRetry: false,
        });
    }

    async restart(): Promise<AgentRuntimeHealth> {
        return this.beginRecovery({
            kind: 'manual',
            forceRestart: true,
            allowAutomaticRetry: false,
        });
    }

    private beginRecovery(options: RuntimeRecoveryOptions): Promise<AgentRuntimeHealth> {
        if (this.recoveryPromise) return this.recoveryPromise;

        const recovery = (async (): Promise<AgentRuntimeHealth> => {
            const isInitialStart = options.kind === 'initial' && !options.forceRestart;
            this.availability = isInitialStart ? 'starting' : 'recovering';
            devLog('INFO', 'PythonRuntimeClient.recovery.start', 'Agent runtime recovery started', {
                kind: options.kind,
                forceRestart: options.forceRestart,
                activeInvocations: this.activeInvocations,
                consecutiveHealthFailures: this.consecutiveHealthFailures,
            });
            try {
                if (options.delayMs) {
                    await new Promise((resolve) => setTimeout(resolve, options.delayMs));
                }
                if (options.kind === 'automatic' && this.activeInvocations > 0) {
                    this.availability = 'slow';
                    this.autoRestartAttempted = false;
                    devLog('INFO', 'PythonRuntimeClient.recovery.deferred', 'Skipped automatic restart while calls are active', {
                        activeInvocations: this.activeInvocations,
                    });
                    return this.statusSnapshot();
                }
                if (
                    options.failedPort
                    && this.port > 0
                    && this.port !== options.failedPort
                    && this.phase === 'ready'
                    && this.process
                ) {
                    this.markHealthy();
                    return this.statusSnapshot();
                }
                if (options.forceRestart) {
                    await this.stop();
                }
                try {
                    await this.ensureStarted();
                } catch (firstError) {
                    if (!options.allowAutomaticRetry || this.autoRestartAttempted) {
                        throw firstError;
                    }
                    this.autoRestartAttempted = true;
                    this.availability = 'recovering';
                    await new Promise((resolve) => setTimeout(resolve, AGENT_RUNTIME_RECOVERY_BACKOFF_MS));
                    await this.stop();
                    await this.ensureStarted();
                }
                this.markHealthy();
                devLog('INFO', 'PythonRuntimeClient.recovery.ready', 'Agent runtime recovery completed', {
                    kind: options.kind,
                    port: this.port,
                });
                return this.statusSnapshot();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.setPhase('failed', message);
                devLogError('PythonRuntimeClient.recovery.failed', error, { kind: options.kind });
                return this.statusSnapshot();
            }
        })();
        this.recoveryPromise = recovery;
        void recovery.then(
            () => {
                if (this.recoveryPromise === recovery) this.recoveryPromise = null;
            },
            () => {
                if (this.recoveryPromise === recovery) this.recoveryPromise = null;
            },
        );
        return recovery;
    }

    private async ensureStarted(): Promise<void> {
        if (this.startPromise) return this.startPromise;
        if (this.process && this.port > 0 && this.phase === 'ready') return;
        if (this.process || this.port > 0) await this.stop();
        this.startPromise = this.start();
        try {
            await this.startPromise;
        } finally {
            this.startPromise = null;
        }
    }

    private resolvePythonCommand(): { command: string; argsPrefix: string[] } {
        const explicit = process.env.NOVEL_AGENT_PYTHON;
        if (explicit && fs.existsSync(explicit)) {
            return { command: explicit, argsPrefix: ['-m', 'novel_agent_runtime'] };
        }

        if (this.isPackaged) {
            const binaryName = process.platform === 'win32' ? 'novel-agent-runtime.exe' : 'novel-agent-runtime';
            const exePath = path.join(process.resourcesPath, 'agent-runtime', binaryName);
            if (fs.existsSync(exePath)) {
                return { command: exePath, argsPrefix: [] };
            }
            throw new Error(`Packaged Agent runtime missing: ${exePath}`);
        }

        const repoRoot = resolveRepoRoot();
        const venvPython = path.join(repoRoot, 'agent_runtime', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        if (fs.existsSync(venvPython)) {
            return { command: venvPython, argsPrefix: ['-m', 'novel_agent_runtime'] };
        }
        return { command: process.platform === 'win32' ? 'python' : 'python3', argsPrefix: ['-m', 'novel_agent_runtime'] };
    }

    private async start(): Promise<void> {
        this.setPhase('starting_python');
        const port = await getFreePort();
        const token = randomUUID();
        this.port = port;
        this.token = token;

        const stateDir = path.join(this.getUserDataPath(), 'agent');
        fs.mkdirSync(stateDir, { recursive: true });

        const { command, argsPrefix } = this.resolvePythonCommand();
        const args = [
            ...argsPrefix,
            '--port',
            String(port),
            '--token',
            token,
            '--automation-runtime',
            this.getAutomationRuntimePath(),
            '--state-dir',
            stateDir,
        ];

        devLog('INFO', 'PythonRuntimeClient.start', 'Starting Python Agent runtime', {
            command,
            args: redactForLog(args),
            port,
        });

        const child = spawn(command, args, {
            cwd: this.isPackaged ? path.dirname(command) : path.join(resolveRepoRoot(), 'agent_runtime'),
            env: {
                ...process.env,
                PYTHONUNBUFFERED: '1',
                LANGGRAPH_STRICT_MSGPACK: 'true',
            },
            windowsHide: true,
        });
        this.process = child;
        this.setPhase('loading_modules');
        let childExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
        let childError: Error | null = null;
        let stdoutBuffer = '';
        devLog('INFO', 'PythonRuntimeClient.start.spawned', 'Python Agent runtime process spawned', {
            pid: child.pid,
            port,
        });

        child.stdout.on('data', (chunk) => {
            stdoutBuffer += String(chunk);
            const lines = stdoutBuffer.split(/\r?\n/u);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                if (!line || this.applyProgressLine(line)) continue;
                devLog('INFO', 'PythonRuntimeClient.stdout', 'Agent runtime stdout', { text: line.slice(0, 1000) });
            }
        });
        child.stderr.on('data', (chunk) => {
            devLog('WARN', 'PythonRuntimeClient.stderr', 'Agent runtime stderr', { text: String(chunk).slice(0, 1000) });
        });
        child.on('exit', (code, signal) => {
            childExit = { code, signal };
            devLog('WARN', 'PythonRuntimeClient.exit', 'Agent runtime exited', { code, signal, pid: child.pid, port });
            if (this.process !== child) {
                return;
            }
            this.process = null;
            this.port = 0;
            this.token = '';
            this.availability = 'starting';
            this.setPhase('idle');
        });
        child.on('error', (error) => {
            childError = error;
            this.disabledReason = error.message;
            if (this.process !== child) {
                devLogError('PythonRuntimeClient.process.error', error);
                return;
            }
            this.process = null;
            this.port = 0;
            this.token = '';
            this.setPhase('failed', error.message);
            devLogError('PythonRuntimeClient.process.error', error);
        });

        try {
            await this.waitForHealth(port, token, () => childExit, () => childError);
            this.markHealthy();
        } catch (error) {
            this.setPhase('failed', error instanceof Error ? error.message : String(error));
            if (this.process === child) {
                await this.stop();
            } else {
                child.kill();
            }
            throw error;
        }
    }

    private async waitForHealth(
        port: number,
        token: string,
        getChildExit?: () => { code: number | null; signal: NodeJS.Signals | null } | null,
        getChildError?: () => Error | null,
    ): Promise<void> {
        const startedAt = Date.now();
        let nextProgressLogAt = AGENT_RUNTIME_STARTUP_PROGRESS_LOG_MS;
        let lastError: unknown;
        while (Date.now() - startedAt < AGENT_RUNTIME_STARTUP_TIMEOUT_MS) {
            const childError = getChildError?.();
            if (childError) throw childError;
            const childExit = getChildExit?.();
            if (childExit) {
                throw Object.assign(
                    new Error(`Agent runtime exited before health check passed: code=${childExit.code ?? 'null'} signal=${childExit.signal ?? 'null'}`),
                    { code: 'AGENT_RUNTIME_EXITED_DURING_STARTUP', details: childExit },
                );
            }
            try {
                const health = await requestJson(port, '/health', token, undefined, 2000);
                if (health.ok) return;
                lastError = new Error(health.message || 'Agent runtime health failed');
            } catch (error) {
                lastError = error;
            }
            const elapsedMs = Date.now() - startedAt;
            if (elapsedMs >= nextProgressLogAt) {
                devLog('WARN', 'PythonRuntimeClient.start.waiting', 'Python Agent runtime is still starting', {
                    port,
                    elapsedMs,
                    timeoutMs: AGENT_RUNTIME_STARTUP_TIMEOUT_MS,
                    lastError: lastError instanceof Error ? lastError.message : String(lastError || ''),
                });
                nextProgressLogAt += AGENT_RUNTIME_STARTUP_PROGRESS_LOG_MS;
            }
            await new Promise((resolve) => setTimeout(resolve, AGENT_RUNTIME_HEALTH_POLL_MS));
        }
        const lastMessage = lastError instanceof Error ? lastError.message : String(lastError || 'unknown error');
        throw Object.assign(
            new Error(`Agent runtime did not become healthy within ${AGENT_RUNTIME_STARTUP_TIMEOUT_MS / 1000}s. Last health error: ${lastMessage}`),
            {
                code: 'AGENT_RUNTIME_STARTUP_TIMEOUT',
                details: { port, timeoutMs: AGENT_RUNTIME_STARTUP_TIMEOUT_MS, lastMessage },
            },
        );
    }
}
