#!/usr/bin/env node
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const options = {
    command: 'node',
    args: [path.join(scriptDir, 'novel-editor-mcp.mjs')],
    tool: 'draft.list',
    toolArgs: {},
    name: 'novel-editor',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--command') {
      options.command = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--args') {
      const raw = argv[index + 1];
      options.args = raw ? JSON.parse(raw) : [];
      index += 1;
      continue;
    }
    if (token === '--tool') {
      options.tool = argv[index + 1];
      index += 1;
      continue;
    }
    if (token === '--tool-args') {
      const raw = argv[index + 1];
      options.toolArgs = raw ? JSON.parse(raw) : {};
      index += 1;
      continue;
    }
    if (token === '--name') {
      options.name = argv[index + 1];
      index += 1;
      continue;
    }
  }

  return options;
}

function encodeMessage(message) {
  const body = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`;
}

async function createMcpClient({ command, args }) {
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  let buffer = Buffer.alloc(0);
  const pending = new Map();

  const failAll = (error) => {
    for (const { reject } of pending.values()) {
      reject(error);
    }
    pending.clear();
  };

  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      let headerEnd = buffer.indexOf('\r\n\r\n');
      let separatorLength = 4;
      if (headerEnd < 0) {
        headerEnd = buffer.indexOf('\n\n');
        separatorLength = 2;
      }
      if (headerEnd < 0) return;
      const headerText = buffer.slice(0, headerEnd).toString('utf8');
      const contentLengthHeader = headerText
        .split(/\r?\n/)
        .find((line) => line.toLowerCase().startsWith('content-length:'));
      if (!contentLengthHeader) {
        failAll(new Error('MCP response missing content-length'));
        buffer = Buffer.alloc(0);
        return;
      }
      const contentLength = Number(contentLengthHeader.split(':')[1]?.trim() || '0');
      const messageStart = headerEnd + separatorLength;
      const messageEnd = messageStart + contentLength;
      if (buffer.length < messageEnd) return;
      const messageText = buffer.slice(messageStart, messageEnd).toString('utf8');
      buffer = buffer.slice(messageEnd);
      const message = JSON.parse(messageText);
      if (typeof message.id !== 'undefined' && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(Object.assign(new Error(message.error.message), message.error));
        else resolve(message.result);
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString('utf8').trim();
    if (text) {
      process.stderr.write(`[mcp-smoke][server] ${text}\n`);
    }
  });

  child.on('exit', (code, signal) => {
    if (pending.size > 0) {
      failAll(new Error(`MCP server exited early (code=${code}, signal=${signal})`));
    }
  });

  const sendRequest = (id, method, params) =>
    new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(encodeMessage({ jsonrpc: '2.0', id, method, params }));
    });

  const close = async () => {
    child.stdin.end();
    child.kill();
  };

  return { sendRequest, close };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = await createMcpClient(options);
  try {
    const init = await client.sendRequest(1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: options.name,
        version: '0.1.0',
      },
    });
    process.stdout.write(`initialize ok: ${JSON.stringify(init.serverInfo)}\n`);

    const tools = await client.sendRequest(2, 'tools/list', {});
    process.stdout.write(`tools/list ok: ${tools.tools.length} tools\n`);

    const toolResult = await client.sendRequest(3, 'tools/call', {
      name: options.tool,
      arguments: options.toolArgs,
    });
    process.stdout.write(`tools/call ok (${options.tool}):\n`);
    process.stdout.write(`${JSON.stringify(toolResult.structuredContent ?? toolResult, null, 2)}\n`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  process.stderr.write(`[mcp-smoke] ${error.code || 'ERROR'}: ${error.message}\n`);
  if (error.details) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  process.exit(1);
});
