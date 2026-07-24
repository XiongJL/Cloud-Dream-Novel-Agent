import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const policySource = await readFile(new URL('../electron/agent/runtimeHealthPolicy.ts', import.meta.url), 'utf8');
const policyOutput = ts.transpileModule(policySource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
    AGENT_RUNTIME_HEALTH_FAILURE_THRESHOLD,
    AGENT_RUNTIME_RECOVERY_BACKOFF_MS,
    recordRuntimeHealthFailure,
} = await import(`data:text/javascript;base64,${Buffer.from(policyOutput).toString('base64')}`);

assert.equal(AGENT_RUNTIME_HEALTH_FAILURE_THRESHOLD, 3);
assert.equal(AGENT_RUNTIME_RECOVERY_BACKOFF_MS, 1_000);

let state = { consecutiveFailures: 0, activeInvocations: 0, autoRestartAttempted: false };
let decision = recordRuntimeHealthFailure(state);
assert.deepEqual(decision, { availability: 'slow', consecutiveFailures: 1, shouldAutoRestart: false });
state = { ...state, consecutiveFailures: decision.consecutiveFailures };

decision = recordRuntimeHealthFailure(state);
assert.deepEqual(decision, { availability: 'slow', consecutiveFailures: 2, shouldAutoRestart: false });
state = { ...state, consecutiveFailures: decision.consecutiveFailures };

decision = recordRuntimeHealthFailure(state);
assert.deepEqual(decision, { availability: 'recovering', consecutiveFailures: 3, shouldAutoRestart: true });

decision = recordRuntimeHealthFailure({
    consecutiveFailures: 2,
    activeInvocations: 1,
    autoRestartAttempted: false,
});
assert.deepEqual(decision, { availability: 'slow', consecutiveFailures: 3, shouldAutoRestart: false });

decision = recordRuntimeHealthFailure({
    consecutiveFailures: 3,
    activeInvocations: 0,
    autoRestartAttempted: true,
});
assert.deepEqual(decision, { availability: 'slow', consecutiveFailures: 4, shouldAutoRestart: false });

const clientSource = await readFile(new URL('../electron/agent/PythonRuntimeClient.ts', import.meta.url), 'utf8');
assert.match(clientSource, /private recoveryPromise: Promise<AgentRuntimeHealth> \| null = null/);
assert.doesNotMatch(clientSource, /restartPromise/);
assert.match(clientSource, /if \(options\.kind === 'automatic' && this\.activeInvocations > 0\)/);
assert.match(clientSource, /this\.activeInvocations \+= 1/);
assert.match(clientSource, /this\.activeInvocations = Math\.max\(0, this\.activeInvocations - 1\)/);
assert.match(clientSource, /this\.markHealthy\(\);\s*if \(!response\.ok\)/s);
assert.match(clientSource, /async ensureReady\(\): Promise<AgentRuntimeHealth>/);
assert.match(clientSource, /async restart\(\): Promise<AgentRuntimeHealth>/);

console.log('Agent Runtime health policy tests passed.');
