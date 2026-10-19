import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(packageRoot, '..', '..');
const requireFromHere = createRequire(import.meta.url);

function resolvePackageJson(specifier) {
    const searchPaths = [packageRoot, workspaceRoot];
    try {
        return requireFromHere.resolve(`${specifier}/package.json`, { paths: searchPaths });
    } catch {
        const pnpmDir = path.join(workspaceRoot, 'node_modules', '.pnpm');
        if (!fs.existsSync(pnpmDir)) {
            throw new Error(`Cannot resolve ${specifier}/package.json and pnpm store was not found.`);
        }
        const normalizedToken = specifier.replace('/', '+');
        const match = fs.readdirSync(pnpmDir).find((entry) => entry.startsWith(`${normalizedToken}@`));
        if (!match) {
            throw new Error(`Cannot resolve ${specifier}/package.json from workspace or pnpm store.`);
        }
        return path.join(pnpmDir, match, 'node_modules', ...specifier.split('/'), 'package.json');
    }
}

function findEngineFile(dir, matcher) {
    return fs.readdirSync(dir).find((name) => matcher(name)) || null;
}

const prismaCliPackageJson = resolvePackageJson('prisma');
const prismaCliPath = path.join(path.dirname(prismaCliPackageJson), 'build', 'index.js');
const schemaPath = path.join(packageRoot, 'prisma', 'schema.prisma');
const generatedClientDir = path.join(packageRoot, 'generated', 'client');
const schemaInitSqlPath = path.join(generatedClientDir, 'schema-init.sql');

const prismaEnginesPackageJson = resolvePackageJson('@prisma/engines');
const prismaEnginesDir = path.dirname(prismaEnginesPackageJson);

const schemaEngineFile = findEngineFile(prismaEnginesDir, (name) => name.startsWith('schema-engine-'));
const queryEngineLibraryFile = findEngineFile(
    prismaEnginesDir,
    (name) =>
        (name.startsWith('query_engine-') || name.startsWith('libquery_engine-')) &&
        name.endsWith('.node'),
);

if (!schemaEngineFile || !queryEngineLibraryFile) {
    console.error('[Prisma Generate] Required local Prisma engines were not found.');
    process.exit(1);
}

const sharedEnv = {
    ...process.env,
    PRISMA_ENGINES_CHECKSUM_IGNORE_MISSING: '1',
    PRISMA_SCHEMA_ENGINE_BINARY: path.join(prismaEnginesDir, schemaEngineFile),
    PRISMA_QUERY_ENGINE_LIBRARY: path.join(prismaEnginesDir, queryEngineLibraryFile),
};

function schemaTokens(source) {
    // Prisma formats the generated schema. Ignore alignment while preserving
    // identifier boundaries, quoted defaults, escapes and documentation.
    return JSON.stringify(source.match(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|[A-Za-z_][A-Za-z_0-9]*|\d+(?:\.\d+)?|[^\s]/g));
}

function sameFileContents(left, right) {
    if (fs.statSync(left).size !== fs.statSync(right).size) return false;
    const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    return digest(left) === digest(right);
}

function canReuseGeneratedClient() {
    try {
        const clientPackageJson = resolvePackageJson('@prisma/client');
        const installed = JSON.parse(fs.readFileSync(clientPackageJson, 'utf8'));
        const generated = JSON.parse(fs.readFileSync(path.join(generatedClientDir, 'package.json'), 'utf8'));
        if (installed.version !== generated.version) return false;
        if (schemaTokens(fs.readFileSync(schemaPath, 'utf8')) !== schemaTokens(
            fs.readFileSync(path.join(generatedClientDir, 'schema.prisma'), 'utf8'),
        )) return false;
        for (const name of ['index.js', 'index.d.ts', 'default.js', 'default.d.ts', 'edge.js', 'index-browser.js', 'runtime/library.js', 'runtime/library.d.ts']) {
            if (!fs.statSync(path.join(generatedClientDir, name)).size) return false;
        }
        if (!fs.readFileSync(path.join(generatedClientDir, 'index.js'), 'utf8').includes(`client: "${installed.version}"`)) return false;
        // Prisma prepends a generated-file comment to the distributed runtime.
        // Compare executable contents, including all of the SDK's bundled code.
        const withoutHeader = source => source.replace(/^(?:\s|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*(?:\r?\n|$))*/, '');
        const generatedRuntime = withoutHeader(fs.readFileSync(path.join(generatedClientDir, 'runtime/library.js'), 'utf8'));
        const installedRuntime = withoutHeader(fs.readFileSync(path.join(path.dirname(clientPackageJson), 'runtime/library.js'), 'utf8'));
        return generatedRuntime === installedRuntime
            && sameFileContents(path.join(generatedClientDir, queryEngineLibraryFile), path.join(prismaEnginesDir, queryEngineLibraryFile));
    } catch {
        return false;
    }
}

if (canReuseGeneratedClient()) {
    // Loaded native modules cannot be replaced on Windows. A current client is
    // safe to reuse while another desktop instance is using the same checkout.
    console.log('[Prisma Generate] Reusing current Prisma client (schema, SDK and engine verified).');
} else {
    const generateResult = spawnSync(process.execPath, [prismaCliPath, 'generate'], {
        cwd: packageRoot, stdio: 'inherit', env: sharedEnv,
    });
    if (generateResult.error) {
        console.error('[Prisma Generate] Failed to execute prisma generate:', generateResult.error);
        process.exit(1);
    }
    if ((generateResult.status ?? 1) !== 0) {
        console.error('[Prisma Generate] Client regeneration is required. If the engine is locked (EPERM), close desktop processes using this checkout and retry.');
        process.exit(generateResult.status ?? 1);
    }
}

const fallbackGeneratedClientDir = path.join(packageRoot, 'node_modules', '.prisma', 'client');
const requiredClientFiles = [
    'default.js',
    'edge.js',
    'index-browser.js',
    'index.js',
    'package.json',
];

if (!fs.existsSync(path.join(generatedClientDir, 'index.js')) && fs.existsSync(fallbackGeneratedClientDir)) {
    if (!fs.existsSync(generatedClientDir)) {
        fs.mkdirSync(generatedClientDir, { recursive: true });
    }
    for (const file of requiredClientFiles) {
        const source = path.join(fallbackGeneratedClientDir, file);
        const target = path.join(generatedClientDir, file);
        if (fs.existsSync(source)) {
            fs.copyFileSync(source, target);
        }
    }
    const fallbackDenoDir = path.join(fallbackGeneratedClientDir, 'deno');
    const generatedDenoDir = path.join(generatedClientDir, 'deno');
    if (fs.existsSync(fallbackDenoDir) && !fs.existsSync(generatedDenoDir)) {
        fs.cpSync(fallbackDenoDir, generatedDenoDir, { recursive: true });
    }
    console.log(`[Prisma Generate] Restored JS client files from ${fallbackGeneratedClientDir}`);
}

const diffResult = spawnSync(
    process.execPath,
    [prismaCliPath, 'migrate', 'diff', '--from-empty', '--to-schema-datamodel', schemaPath, '--script'],
    {
        cwd: packageRoot,
        encoding: 'utf8',
        env: sharedEnv,
    },
);

if (diffResult.error) {
    console.error('[Prisma Generate] Failed to generate schema-init.sql:', diffResult.error);
    process.exit(1);
}

if ((diffResult.status ?? 1) !== 0) {
    if (diffResult.stdout) process.stdout.write(diffResult.stdout);
    if (diffResult.stderr) process.stderr.write(diffResult.stderr);
    process.exit(diffResult.status ?? 1);
}

if (!fs.existsSync(generatedClientDir)) {
    fs.mkdirSync(generatedClientDir, { recursive: true });
}

fs.writeFileSync(schemaInitSqlPath, diffResult.stdout ?? '', 'utf8');
console.log(`[Prisma Generate] Wrote schema init SQL to ${schemaInitSqlPath}`);
