import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const policySource = await readFile(new URL('../electron/agent/runtimeHealthPolicy.ts', import.meta.url), 'utf8');
let clientSource = await readFile(new URL('../electron/agent/PythonRuntimeClient.ts', import.meta.url), 'utf8');
clientSource = clientSource
    .replace(/^import .*?;\r?\n/gmu, '')
    .replace(/import \{[\s\S]*?\} from '\.\/runtimeHealthPolicy';\r?\n/u, '')
    .replace(/import \{[\s\S]*?\} from '\.\/agentSseClient';\r?\n/u, '')
    .replace(/import \{[\s\S]*?\} from '\.\.\/debug\/devLogger';\r?\n/u, '');

const testStubs = `
const devLog = () => undefined;
const devLogError = () => undefined;
const redactForLog = (value: unknown) => value;
const subscribeAgentRunEventsHttp = () => () => undefined;
`;
const output = ts.transpileModule(`${policySource}\n${testStubs}\n${clientSource}`, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { PythonRuntimeClient } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

const createClient = () => new PythonRuntimeClient({
    getUserDataPath: () => '.',
    getAutomationRuntimePath: () => '.',
    isPackaged: false,
});
const fakeProcess = (onKill = () => undefined) => ({ kill: onKill });

const singleFlightClient = createClient();
let singleFlightStarts = 0;
singleFlightClient.start = async () => {
    singleFlightStarts += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    singleFlightClient.process = fakeProcess();
    singleFlightClient.port = 41001;
};
const [firstManual, secondManual] = await Promise.all([
    singleFlightClient.restart(),
    singleFlightClient.restart(),
]);
assert.equal(singleFlightStarts, 1, 'concurrent manual retries must share one start');
assert.equal(firstManual.ok, true);
assert.equal(secondManual.ok, true);
assert.equal(firstManual.data.availability, 'ready');

const startupRetryClient = createClient();
let startupAttempts = 0;
startupRetryClient.start = async () => {
    startupAttempts += 1;
    throw new Error('injected startup failure');
};
const failed = await startupRetryClient.beginRecovery({
    kind: 'initial',
    forceRestart: false,
    allowAutomaticRetry: true,
});
assert.equal(startupAttempts, 2, 'initial failure should perform exactly one automatic restart');
assert.equal(failed.ok, false);
assert.equal(failed.data.availability, 'failed');
assert.equal(failed.data.canManualRetry, true);

startupRetryClient.start = async () => {
    startupAttempts += 1;
    startupRetryClient.process = fakeProcess();
    startupRetryClient.port = 41002;
};
const recovered = await startupRetryClient.ensureReady();
assert.equal(startupAttempts, 3, 'failed state must permit request-time recovery');
assert.equal(recovered.ok, true);
assert.equal(recovered.data.availability, 'ready');
assert.equal(recovered.data.autoRestartAttempted, false);

const activeCallClient = createClient();
let killed = 0;
activeCallClient.process = fakeProcess(() => { killed += 1; });
activeCallClient.port = 41003;
activeCallClient.phase = 'ready';
activeCallClient.availability = 'recovering';
activeCallClient.activeInvocations = 1;
activeCallClient.autoRestartAttempted = true;
activeCallClient.consecutiveHealthFailures = 3;
const deferred = await activeCallClient.beginRecovery({
    kind: 'automatic',
    forceRestart: true,
    allowAutomaticRetry: false,
});
assert.equal(killed, 0, 'automatic recovery must not kill a Runtime with active calls');
assert.equal(deferred.ok, true);
assert.equal(deferred.data.availability, 'slow');
assert.equal(deferred.data.autoRestartAttempted, false);

console.log('Agent Runtime client recovery tests passed.');
