import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { McpServerStatus } from '../../shared/mcpServer';

type Options = {
    userDataPath: string;
    runtimePath: string;
    command: string;
    argsPrefix: string[];
    cwd: string;
    onEnabledChanged: (enabled: boolean) => void;
};
type Config = { enabled: boolean; port: number; token: string };

/** One lightweight FastMCP process, independent of the internal Agent runtime. */
export class McpServerManager {
    private config: Config;
    private readonly configPath: string;
    private child: ChildProcess | null = null;
    private state: McpServerStatus['state'] = 'disabled';
    private error?: string;
    private queue: Promise<unknown> = Promise.resolve();
    private shuttingDown = false;
    private revision = 0;
    private childPort?: number;

    constructor(private readonly options: Options) {
        this.configPath = path.join(options.userDataPath, 'mcp', 'settings.json');
        this.config = { enabled: true, port: 18765, token: randomBytes(32).toString('hex') };
        if (fs.existsSync(this.configPath)) {
            try {
                const saved = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
                if (typeof saved.enabled !== 'boolean' || !Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535
                    || typeof saved.token !== 'string' || saved.token.length < 32) throw new Error('Invalid MCP settings');
                this.config = { enabled: saved.enabled, port: saved.port, token: saved.token };
            } catch {
                this.config.enabled = false;
                this.error = 'MCP settings could not be read. Enable MCP to create a new local configuration.';
            }
        }
        this.state = this.config.enabled ? 'starting' : 'disabled';
        options.onEnabledChanged(this.config.enabled);
    }

    status(): McpServerStatus {
        return {
            enabled: this.config.enabled, state: this.state, port: this.config.port,
            url: `http://127.0.0.1:${this.config.port}/mcp`,
            ...(this.state === 'running' ? { token: this.config.token } : {}),
            ...(this.error ? { error: this.error } : {}),
        };
    }

    configure(enabled: boolean, port = this.config.port): Promise<McpServerStatus> {
        if (typeof enabled !== 'boolean' || !Number.isInteger(port) || port < 1024 || port > 65535) {
            return Promise.reject(new Error('MCP port must be between 1024 and 65535'));
        }
        if (this.shuttingDown) return Promise.reject(new Error('Application is shutting down'));
        let revision: number;
        try {
            const next = { ...this.config, enabled, port };
            fs.mkdirSync(path.dirname(this.configPath), { recursive: true });
            const temporary = `${this.configPath}.${randomUUID()}.tmp`;
            try {
                fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
                fs.renameSync(temporary, this.configPath);
            } finally {
                fs.rmSync(temporary, { force: true });
            }
            const restart = port !== this.config.port;
            this.config = next;
            this.options.onEnabledChanged(enabled);
            this.error = undefined;
            revision = ++this.revision;
            // Stop admission immediately, including while a previous start is pending.
            if (!enabled || restart) this.child?.kill();
            if (!enabled) this.state = 'disabled';
        } catch (error) {
            this.error = String(error).split(this.config.token).join('[redacted]');
            if (!this.child && this.config.enabled) this.state = 'error';
            return Promise.reject(error);
        }
        const operation = this.queue.then(async () => {
            if (revision !== this.revision || this.shuttingDown) return this.status();
            if (this.child && (this.child.killed || this.childPort !== this.config.port)) await this.stopChild();
            if (!this.config.enabled) await this.stopChild();
            else if (!this.child) await this.startChild(revision);
            return this.status();
        });
        this.queue = operation.catch(() => {});
        return operation;
    }

    private async startChild(revision: number): Promise<void> {
        this.state = 'starting';
        const instance = randomUUID();
        let failure = '';
        let stderr = '';
        const child = spawn(this.options.command, [
            ...this.options.argsPrefix, '--transport', 'http', '--parent-stdio',
            '--port', String(this.config.port), '--runtime-file', this.options.runtimePath,
        ], {
            cwd: this.options.cwd, windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'],
            env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1',
                NOVEL_MCP_HTTP_TOKEN: this.config.token, NOVEL_MCP_INSTANCE: instance },
        });
        this.child = child;
        this.childPort = this.config.port;
        child.stderr?.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-1600); });
        child.on('error', error => { failure = error.message; });
        child.on('exit', (code, signal) => {
            failure ||= `MCP process exited (${code ?? signal})`;
            if (this.child === child) {
                this.child = null;
                this.state = this.config.enabled && !this.shuttingDown ? 'error' : 'disabled';
                this.error = this.state === 'error' ? failure : undefined;
            }
        });
        try {
            const deadline = Date.now() + 45_000;
            while (Date.now() < deadline && !this.shuttingDown && revision === this.revision) {
                if (failure) throw new Error(`${failure}\n${stderr}`);
                try {
                    const response = await fetch(`http://127.0.0.1:${this.config.port}/health`, {
                        headers: { Authorization: `Bearer ${this.config.token}` }, signal: AbortSignal.timeout(500),
                    });
                    const health = response.ok ? await response.json() : null;
                    if (!this.shuttingDown && revision === this.revision && health?.instance === instance && health?.service === 'novel-editor-mcp') {
                        this.state = 'running';
                        return;
                    }
                } catch { /* The listener may still be starting. */ }
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            if (revision !== this.revision || this.shuttingDown) { await this.stopChild(); return; }
            throw new Error('MCP startup timed out');
        } catch (error) {
            await this.stopChild();
            if (revision === this.revision && !this.shuttingDown) {
                this.state = 'error';
                this.error = String(error).split(this.config.token).join('[redacted]');
            }
        }
    }

    private async stopChild(): Promise<void> {
        const child = this.child;
        this.child = null;
        if (!child) return;
        await new Promise<void>(resolve => {
            const timeout = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
            child.once('close', () => { clearTimeout(timeout); resolve(); });
            child.stdin?.end();
            child.kill();
        });
    }

    async stop(): Promise<void> {
        this.shuttingDown = true;
        this.revision++;
        this.options.onEnabledChanged(false);
        await this.stopChild();
        this.state = 'disabled';
    }
}
