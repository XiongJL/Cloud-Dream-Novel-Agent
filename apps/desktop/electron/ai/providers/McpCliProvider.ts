import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { AiGenerateRequest, AiGenerateResponse, AiHealthCheckResult, AiProvider, AiSettings } from '../types';
import { devLog, devLogError, redactForLog } from '../../debug/devLogger';

function splitArgs(raw: string): string[] {
    if (!raw.trim()) return [];
    const matches = raw.match(/"[^"]*"|'[^']*'|\S+/g) || [];
    return matches.map((token) => token.replace(/^['"]|['"]$/g, ''));
}

export class McpCliProvider implements AiProvider {
    public readonly name = 'mcp-cli' as const;

    constructor(private readonly settings: AiSettings) { }

    async healthCheck(): Promise<AiHealthCheckResult> {
        const { cliPath } = this.settings.mcpCli;
        if (!cliPath.trim()) {
            return { ok: false, detail: 'MCP CLI path is empty' };
        }

        if (!fs.existsSync(cliPath)) {
            return { ok: false, detail: 'MCP CLI path does not exist' };
        }

        try {
            devLog('INFO', 'McpCliProvider.healthCheck.request', 'MCP CLI health check request', {
                cliPath,
                timeoutMs: this.settings.mcpCli.startupTimeoutMs,
            });
            const { stdout } = await this.runProcess(['--version'], '', this.settings.mcpCli.startupTimeoutMs);
            devLog('INFO', 'McpCliProvider.healthCheck.response', 'MCP CLI health check response', {
                cliPath,
                stdout,
            });
            return { ok: true, detail: (stdout || 'MCP CLI is executable').slice(0, 200) };
        } catch (error: any) {
            devLogError('McpCliProvider.healthCheck.error', error, { cliPath });
            return { ok: false, detail: `MCP CLI check failed: ${error?.message || 'unknown error'}` };
        }
    }

    async generate(req: AiGenerateRequest): Promise<AiGenerateResponse> {
        const prompt = req.prompt.trim();
        if (!prompt) {
            return { text: '', model: 'mcp-cli' };
        }

        const argsTemplate = this.settings.mcpCli.argsTemplate || '';
        const hasPromptPlaceholder = argsTemplate.includes('{prompt}');
        const parsedArgs = splitArgs(argsTemplate.replace('{prompt}', prompt));

        devLog('INFO', 'McpCliProvider.generate.request', 'MCP CLI generate request', {
            cliPath: this.settings.mcpCli.cliPath,
            args: parsedArgs,
            prompt: hasPromptPlaceholder ? '' : prompt,
            promptEmbeddedInArgs: hasPromptPlaceholder,
        });

        const { stdout } = await this.runProcess(
            parsedArgs,
            hasPromptPlaceholder ? '' : prompt,
            this.settings.mcpCli.startupTimeoutMs,
            req.signal,
            req.onActivity,
        );

        devLog('INFO', 'McpCliProvider.generate.response', 'MCP CLI generate response', {
            cliPath: this.settings.mcpCli.cliPath,
            stdout,
        });

        return {
            text: stdout.trim(),
            model: 'mcp-cli',
        };
    }

    private async runProcess(
        args: string[],
        stdinText: string,
        timeoutMs: number,
        signal?: AbortSignal,
        onActivity?: (kind: 'first_byte' | 'chunk') => void,
    ): Promise<{ stdout: string; stderr: string }> {
        const { cliPath, workingDir, envJson } = this.settings.mcpCli;
        const extraEnv = this.parseEnvJson(envJson);
        const startedAt = Date.now();

        return new Promise((resolve, reject) => {
            const child = spawn(cliPath, args, {
                cwd: workingDir || process.cwd(),
                env: { ...process.env, ...extraEnv },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });

            let stdout = '';
            let stderr = '';
            let done = false;
            let receivedFirstByte = false;
            const removeAbortListener = () => signal?.removeEventListener('abort', onAbort);
            const onAbort = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                child.kill('SIGTERM');
                removeAbortListener();
                reject(new Error('AI request cancelled'));
            };

            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                child.kill('SIGTERM');
                removeAbortListener();
                devLog('ERROR', 'McpCliProvider.runProcess.timeout', 'MCP CLI process timeout', {
                    cliPath,
                    args,
                    elapsedMs: Date.now() - startedAt,
                });
                reject(new Error('MCP CLI process timeout'));
            }, Math.max(1000, timeoutMs));
            if (signal?.aborted) onAbort();
            else signal?.addEventListener('abort', onAbort, { once: true });

            child.stdout.on('data', (chunk) => {
                stdout += chunk.toString();
                onActivity?.(receivedFirstByte ? 'chunk' : 'first_byte');
                receivedFirstByte = true;
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk.toString();
            });

            child.on('error', (error) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                removeAbortListener();
                devLogError('McpCliProvider.runProcess.error', error, {
                    cliPath,
                    args,
                    elapsedMs: Date.now() - startedAt,
                    env: redactForLog(extraEnv),
                });
                reject(error);
            });

            child.on('close', (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                removeAbortListener();

                if (code !== 0) {
                    devLog('ERROR', 'McpCliProvider.runProcess.exit', 'MCP CLI exited with non-zero code', {
                        cliPath,
                        args,
                        code,
                        elapsedMs: Date.now() - startedAt,
                        stderr,
                    });
                    reject(new Error(`MCP CLI exited with code ${code}: ${stderr.slice(0, 300)}`));
                    return;
                }

                devLog('INFO', 'McpCliProvider.runProcess.exit', 'MCP CLI process completed', {
                    cliPath,
                    args,
                    code,
                    elapsedMs: Date.now() - startedAt,
                    stderr,
                });
                resolve({ stdout, stderr });
            });

            if (stdinText) {
                child.stdin.write(stdinText);
            }
            child.stdin.end();
        });
    }

    private parseEnvJson(raw: string): Record<string, string> {
        if (!raw.trim()) return {};
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return {};

            const result: Record<string, string> = {};
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
                result[key] = String(value ?? '');
            }
            return result;
        } catch {
            return {};
        }
    }
}
