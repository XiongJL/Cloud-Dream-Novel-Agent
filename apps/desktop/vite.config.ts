import path from 'node:path'
import { rm } from 'node:fs/promises'
import react from '@vitejs/plugin-react'
import electronSimpleImport from 'vite-plugin-electron/simple'
import { defineConfig, type Plugin } from 'vite'

const electronSimple =
    typeof electronSimpleImport === 'function'
        ? electronSimpleImport
        : (electronSimpleImport as { default?: typeof electronSimpleImport }).default

if (typeof electronSimple !== 'function') {
    throw new TypeError('vite-plugin-electron/simple did not export a callable plugin factory')
}

// Some shells inherit ELECTRON_RUN_AS_NODE=1 from tooling, which makes the
// Electron binary behave like plain Node and breaks named imports such as
// BrowserWindow in the main process.
delete process.env.ELECTRON_RUN_AS_NODE

const wait = (delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs))

function prepareElectronDevOutput(): Plugin {
    return {
        name: 'novel-editor:prepare-electron-dev-output',
        apply: 'serve',
        async configResolved(config) {
            const mainOutput = path.join(config.root, 'dist-electron', 'main.js')
            for (let attempt = 0; attempt < 8; attempt += 1) {
                try {
                    await rm(mainOutput, { force: true })
                    return
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code || ''
                    const retryable = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'UNKNOWN'
                    if (!retryable || attempt === 7) throw error
                    await wait(75 * (attempt + 1))
                }
            }
        },
    }
}

// https://vitejs.dev/config/
export default defineConfig(() => {
    const devHost = process.env.VITE_DEV_HOST || '127.0.0.1'
    const parsedPort = Number(process.env.VITE_DEV_PORT || '5173')
    const devPort = Number.isFinite(parsedPort) ? parsedPort : 5173

    return {
        server: {
            host: devHost,
            port: devPort,
            strictPort: true,
        },
        plugins: [
            react(),
            prepareElectronDevOutput(),
            electronSimple({
                main: {
                    entry: 'electron/main.ts',
                    vite: {
                        build: {
                            rollupOptions: {
                                external: ['@novel-editor/core', '@prisma/client', '.prisma/client', 'mammoth', 'pdf-parse'],
                            },
                        },
                        resolve: {
                            conditions: ['node'],
                            mainFields: ['module', 'jsnext:main', 'jsnext'],
                        },
                    },
                },
                preload: {
                    input: path.join(__dirname, 'electron/preload.ts'),
                },
                renderer: {},
            }),
        ],
    }
})
