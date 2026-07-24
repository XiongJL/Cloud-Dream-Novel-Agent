import path from 'node:path'
import react from '@vitejs/plugin-react'
import electronSimpleImport from 'vite-plugin-electron/simple'
import { defineConfig } from 'vite'

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
