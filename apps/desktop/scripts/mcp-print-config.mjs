#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

function parseArgs(argv) {
  const options = {
    format: 'all',
    copy: '',
    serverName: 'novel_editor',
    startupTimeoutSec: 60,
    toolTimeoutSec: 120,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--format') {
      options.format = String(argv[i + 1] || 'all').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token === '--copy') {
      options.copy = String(argv[i + 1] || '').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token === '--name') {
      options.serverName = String(argv[i + 1] || options.serverName).trim() || options.serverName;
      i += 1;
      continue;
    }
    if (token === '--startup-timeout') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) options.startupTimeoutSec = value;
      i += 1;
      continue;
    }
    if (token === '--tool-timeout') {
      const value = Number(argv[i + 1]);
      if (Number.isFinite(value) && value > 0) options.toolTimeoutSec = value;
      i += 1;
      continue;
    }
  }

  return options;
}

function quoteWindowsArg(value) {
  if (!value) return '""';
  if (!/[ \t"]/u.test(value)) return value;
  return `"${value.replace(/"/gu, '\\"')}"`;
}

function buildConfig(options) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const cmdPath = path.join(scriptDir, 'novel-editor-mcp.cmd');
  const cmdPathEscaped = cmdPath.replace(/\\/gu, '\\\\');
  const codexToml = [
    `[mcp_servers.${options.serverName}]`,
    'command = "cmd"',
    `args = ["/c", "${cmdPathEscaped}"]`,
    `startup_timeout_sec = ${options.startupTimeoutSec}`,
    `tool_timeout_sec = ${options.toolTimeoutSec}`,
  ].join('\n');

  const jsonConfig = JSON.stringify(
    {
      mcpServers: {
        [options.serverName]: {
          command: 'cmd',
          args: ['/c', cmdPath],
        },
      },
    },
    null,
    2,
  );

  const claudeCommand = `claude mcp add novel-editor --scope local -- cmd /c ${quoteWindowsArg(cmdPath)}`;

  return {
    cmdPath,
    codexToml,
    jsonConfig,
    claudeCommand,
  };
}

function copyToClipboard(text) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      message: 'Clipboard copy is currently only implemented for Windows.',
    };
  }
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-Command', 'Set-Clipboard -Value ([Console]::In.ReadToEnd())'],
    {
      input: text,
      encoding: 'utf8',
    },
  );
  if (result.status === 0) {
    return { ok: true, message: 'Copied to clipboard.' };
  }
  return {
    ok: false,
    message: (result.stderr || result.stdout || 'Failed to copy to clipboard.').trim(),
  };
}

function printBlock(title, body) {
  process.stdout.write(`\n# ${title}\n${body}\n`);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = buildConfig(options);

  process.stdout.write(`CloudDream Novel Agent MCP launcher:\n${output.cmdPath}\n`);

  if (options.format === 'all' || options.format === 'codex') {
    printBlock('Codex config.toml', output.codexToml);
  }
  if (options.format === 'all' || options.format === 'claude') {
    printBlock('Claude Code command', output.claudeCommand);
  }
  if (options.format === 'all' || options.format === 'json') {
    printBlock('Generic mcpServers JSON', output.jsonConfig);
  }

  if (options.copy) {
    const target =
      options.copy === 'codex'
        ? output.codexToml
        : options.copy === 'claude'
          ? output.claudeCommand
          : options.copy === 'json'
            ? output.jsonConfig
            : '';
    if (!target) {
      process.stderr.write('Unsupported --copy target. Use: codex | claude | json\n');
      process.exit(1);
      return;
    }
    const copyResult = copyToClipboard(target);
    if (!copyResult.ok) {
      process.stderr.write(`${copyResult.message}\n`);
      process.exit(1);
      return;
    }
    process.stdout.write(`${copyResult.message}\n`);
  }
}

main();
