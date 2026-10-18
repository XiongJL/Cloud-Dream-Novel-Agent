import React, { useEffect, useRef, useState } from 'react';
import Home from './pages/Home';
import './index.css';

import { EditorPreferencesProvider } from './hooks/useEditorPreferences';

import { Toaster } from 'sonner';
import type { BackupProgress } from '../shared/backup';
import { BackupProgressDialog } from './components/Settings/BackupProgressDialog';

function App() {
    const [backupBusy, setBackupBusy] = useState(false);
    const backupBusyRef = useRef(false);
    const [progress, setProgress] = useState<BackupProgress | null>(null);
    useEffect(() => window.backup.onMaintenance(value => { backupBusyRef.current = value; setBackupBusy(value); if (value) setProgress(null); }), []);
    useEffect(() => window.backup.onProgress(setProgress), []);
    useEffect(() => {
        const block = (event: KeyboardEvent) => {
            if (!backupBusyRef.current) return;
            if (event.target instanceof HTMLElement && event.target.closest('[data-backup-overlay]') && !event.ctrlKey && !event.metaKey && !event.altKey && ['Tab', 'Enter', ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault(); event.stopImmediatePropagation();
        };
        // Register before settings dialogs open, so their Escape handlers cannot
        // close the underlying dialog while a backup task owns keyboard input.
        window.addEventListener('keydown', block, true);
        return () => window.removeEventListener('keydown', block, true);
    }, []);
    return (
        <React.StrictMode>
            <EditorPreferencesProvider>
                <Home />
                <Toaster richColors position="top-right" />
                {backupBusy && <BackupProgressDialog progress={progress} />}
            </EditorPreferencesProvider>
        </React.StrictMode>
    );
}

export default App;
