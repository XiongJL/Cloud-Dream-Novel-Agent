import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import http from 'node:http';

const policySource = await readFile(new URL('../electron/agent/runtimeHealthPolicy.ts', import.meta.url), 'utf8');
let clientSource = await readFile(new URL('../electron/agent/PythonRuntimeClient.ts', import.meta.url), 'utf8');
clientSource = clientSource
    .replace(/^import .*?;\r?\n/gmu, '')
    .replace(/import \{[\s\S]*?\} from '\.\/runtimeHealthPolicy';\r?\n/u, '')
    .replace(/import \{[\s\S]*?\} from '\.\/agentSseClient';\r?\n/u, '')
    .replace(/import \{[\s\S]*?\} from '\.\.\/debug\/devLogger';\r?\n/u, '');

const testStubs = `
import http from 'node:http';
const devLog = () => undefined;
const devLogError = () => undefined;
const redactForLog = (value: unknown) => value;
const subscribeAgentRunEventsHttp = () => () => undefined;
let requestCounter = 0;
const randomUUID = () => 'request-' + (++requestCounter);
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

const resetClient = createClient();
let resetKills = 0;
resetClient.process = fakeProcess(() => { resetKills += 1; });
resetClient.port = 41004;
resetClient.phase = 'ready';
resetClient.availability = 'ready';
resetClient.activeInvocations = 1; // The original run's SSE subscription.
resetClient.probeRuntimeConnection = async () => ({ ok: true });
const readRequests = [];
resetClient.invokeOnce = async envelope => {
    readRequests.push(envelope);
    if (readRequests.length === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return { status: 'running' };
};
assert.deepEqual(await resetClient.invoke({ method: 'agent.run_status', params: { runId: 'original' } }), { status: 'running' });
assert.equal(resetKills, 0, 'a reset status socket must not terminate the running analysis');
assert.equal(readRequests[0].requestId, readRequests[1].requestId);
assert.equal(resetClient.activeInvocations, 1);

const mutationRequests = [];
resetClient.invokeOnce = async envelope => {
    mutationRequests.push(envelope);
    throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
};
await assert.rejects(resetClient.invoke({ method: 'agent.execute_plan' }), error =>
    error.code === 'AGENT_RUNTIME_CONNECTION_LOST' && error.details.resultUnknown === true);
assert.equal(mutationRequests.length, 1, 'a lost command acknowledgement must not create a second run');
assert.equal(resetKills, 0);

const slowWorker = createClient();
let slowKills = 0;
slowWorker.process = fakeProcess(() => { slowKills += 1; });
slowWorker.port = 41005;
slowWorker.phase = 'ready';
slowWorker.consecutiveHealthFailures = 3;
slowWorker.probeRuntimeConnection = async () => { throw new Error('health timeout'); };
const slow = await slowWorker.beginRecovery({ kind: 'automatic', forceRestart: true, allowAutomaticRetry: false });
assert.equal(slow.data.availability, 'slow');
assert.equal(slow.data.canManualRetry, true, 'persistent unresponsiveness must expose an explicit restart action');
assert.equal(slowKills, 0, 'an inconclusive health probe without an invoke RPC cannot establish that a background worker died');

const deadClient = createClient();
let deadStarts = 0;
deadClient.ensureReady = async () => ({ ok: true });
deadClient.port = 41006;
deadClient.start = async () => {
    deadStarts += 1;
    deadClient.process = fakeProcess();
    deadClient.port = 41007;
};
let deadReads = 0;
deadClient.invokeOnce = async () => {
    if (++deadReads === 1) throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED', port: 41006 });
    return { status: 'failed' };
};
assert.deepEqual(await deadClient.invoke({ method: 'agent.run_status' }), { status: 'failed' });
assert.equal(deadStarts, 1, 'a confirmed exited process still starts a replacement');

const staleClient = createClient();
let staleKills = 0;
staleClient.process = fakeProcess(() => { staleKills += 1; });
staleClient.port = 41008;
staleClient.phase = 'ready';
staleClient.availability = 'ready';
let staleReads = 0;
staleClient.invokeOnce = async () => {
    if (++staleReads === 1) {
        staleClient.port = 41009;
        throw Object.assign(new Error('old socket reset'), { code: 'ECONNRESET' });
    }
    return { status: 'completed' };
};
assert.deepEqual(await staleClient.invoke({ method: 'agent.run_status' }), { status: 'completed' });
assert.equal(staleKills, 0, 'a late error from the captured old port must not restart its replacement');

// Exercise real health responses across startup, ready fast paths, and restart.
let workerHealthData = { toolTransport: 'native', capabilities: ['agent.skill.packs', 'agent.skill.visibility'] };
const healthServer = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ok: true, data: workerHealthData }));
});
await new Promise(resolve => healthServer.listen(0, '127.0.0.1', resolve));
try {
    const capabilityClient = createClient();
    const healthPort = healthServer.address().port;
    capabilityClient.start = async () => {
        capabilityClient.process = fakeProcess();
        capabilityClient.port = healthPort;
        capabilityClient.phase = 'starting_server';
        await capabilityClient.waitForHealth(healthPort, '');
        capabilityClient.markHealthy();
    };
    const initial = await capabilityClient.ensureReady();
    assert.equal(initial.data.toolTransport, 'native', 'startup must carry the worker health response');
    assert.deepEqual(initial.data.capabilities, workerHealthData.capabilities);
    assert.deepEqual((await capabilityClient.ensureReady()).data.capabilities, workerHealthData.capabilities, 'send-time ready snapshot must retain capabilities');
    assert.deepEqual((await capabilityClient.health()).data.capabilities, workerHealthData.capabilities);
    assert.deepEqual((await capabilityClient.restart()).data.capabilities, workerHealthData.capabilities, 'manual restart must return capabilities immediately');
    assert.equal((await capabilityClient.ensureReady()).data.toolTransport, 'native');

    // A replacement worker must never inherit support from the old process.
    workerHealthData = { capabilities: ['agent.roles'] };
    const replacementWorker = await capabilityClient.restart();
    assert.equal(replacementWorker.data.toolTransport, undefined);
    assert.deepEqual(replacementWorker.data.capabilities, ['agent.roles']);
    await capabilityClient.stop();
    assert.equal(capabilityClient.statusSnapshot().data.capabilities, undefined);
} finally {
    await new Promise(resolve => healthServer.close(resolve));
}

console.log('Agent Runtime client recovery tests passed.');
