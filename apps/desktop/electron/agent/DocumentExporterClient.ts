import { app } from 'electron';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import type { NovelExportFormat } from '../../shared/novelExport';

export type ExporterSummary = { chapters: number; volumes: number; empty: boolean };

export class DocumentExporterClient {
    generate(directory: string, format: NovelExportFormat, jobId: string, progress: (completed: number) => void): Promise<ExporterSummary> {
        const root = app.isPackaged
            ? path.join(process.resourcesPath, 'agent-runtime', 'document-exporter')
            : path.resolve(app.getAppPath(), '..', '..', 'agent_runtime');
        const command = app.isPackaged
            ? path.join(root, process.platform === 'win32' ? 'document-exporter.exe' : 'document-exporter')
            : process.env.NOVEL_DOCUMENT_EXPORTER_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        return new Promise((resolve, reject) => {
            const child = spawn(command, app.isPackaged ? [] : ['-m', 'document_exporter'], {
                cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            });
            let result: ExporterSummary | undefined;
            let failure: Error | undefined;
            let received = 0;
            let settled = false;
            const finish = (error?: Error) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (error) reject(error);
                else if (result) resolve(result);
                else reject(new Error('文档生成组件未返回结果。'));
            };
            const timer = setTimeout(() => {
                child.kill();
                // Wait for close before the caller removes files still owned by the worker.
                failure = new Error('文档生成超时，请重试。');
            }, 5 * 60_000);
            child.stdout.on('data', (chunk: Buffer) => {
                received += chunk.length;
                if (received > 4 * 1024 * 1024) {
                    failure = new Error('文档生成组件返回数据过多。');
                    child.kill();
                }
            });
            const lines = createInterface({ input: child.stdout });
            lines.on('line', line => {
                if (failure) return;
                try {
                    const event = JSON.parse(line);
                    if (event.protocolVersion !== 'document-exporter-v1' || event.jobId !== jobId) throw new Error();
                    if (event.type === 'progress' && Number.isSafeInteger(event.completed) && event.completed >= 0) {
                        progress(event.completed);
                    } else if (event.type === 'result' && !result) {
                        if (!event.ok) {
                            failure = new Error(String(event.message || '文档生成失败。'));
                        } else if (Number.isSafeInteger(event.chapters) && event.chapters >= 0
                            && Number.isSafeInteger(event.volumes) && event.volumes >= 0 && typeof event.empty === 'boolean') {
                            result = { chapters: event.chapters, volumes: event.volumes, empty: event.empty };
                        } else throw new Error();
                    } else throw new Error();
                } catch {
                    failure = new Error('文档生成组件返回了无效结果。');
                    child.kill();
                }
            });
            child.stderr.resume();
            child.stdin.on('error', () => { failure ??= new Error('无法向文档生成组件传递数据。'); });
            child.on('error', () => finish(new Error('文档生成组件不可用，请检查安装是否完整。')));
            child.on('close', code => finish(failure || (code !== 0 ? new Error('文档生成组件异常退出。') : undefined)));
            child.stdin.end(JSON.stringify({ protocolVersion: 'document-exporter-v1', jobId, directory, format }));
        });
    }
}
