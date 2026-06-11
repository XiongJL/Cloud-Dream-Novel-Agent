import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Upload, Shield, ArchiveRestore, Clock, History } from 'lucide-react';
import { Button } from '../ui/Button';
import { ConfirmModal } from '../ui/ConfirmModal';
import { useEditorPreferences } from '../../hooks/useEditorPreferences';
import { toast } from 'sonner';

interface AutoBackupInfo {
    filename: string;
    createdAt: number;
    size: number;
}

export const BackupRestorePanel: React.FC = () => {
    const { t } = useTranslation();
    const { preferences } = useEditorPreferences();

    // Export state
    const [exportPassword, setExportPassword] = useState('');
    const [isExportEncrypting, setIsExportEncrypting] = useState(false);

    // Import state
    const [importPassword, setImportPassword] = useState(''); // Password entered in the UI before clicking restore
    const [isImportEncrypting, setIsImportEncrypting] = useState(false); // Toggle for showing password input

    const [isLoading, setIsLoading] = useState(false);
    const [autoBackups, setAutoBackups] = useState<AutoBackupInfo[]>([]);
    const [pendingRestore, setPendingRestore] = useState<string | null>(null);

    useEffect(() => {
        loadAutoBackups();
    }, []);

    const loadAutoBackups = async () => {
        try {
            const backups = await window.backup.getAutoBackups();
            setAutoBackups(backups);
        } catch (e) {
            console.error('Failed to load auto backups', e);
        }
    };

    const handleExport = async () => {
        setIsLoading(true);
        try {
            await window.backup.export(isExportEncrypting ? exportPassword : undefined);
            toast.success(t('backup.exportSuccess'));
        } catch (e) {
            toast.error(t('backup.exportFailed'));
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleImport = async () => {
        setIsLoading(true);
        try {
            // Priority: Use UI password if provided, otherwise undefined
            const initialPassword = isImportEncrypting ? importPassword : undefined;

            // Attempt import
            const result = await window.backup.import(undefined, initialPassword);

            if (result.success) {
                toast.success(t('backup.importSuccess'));
                window.location.reload();
                return;
            }

            if (result.code === 'CANCELLED') {
                return;
            }

            if (result.code === 'PASSWORD_REQUIRED') {
                toast.error(t('backup.passwordRequiredDesc'));
            } else if (result.code === 'PASSWORD_INVALID') {
                toast.error(t('backup.passwordInvalid'));
            } else {
                throw new Error(result.message || 'Import failed');
            }
        } catch (e) {
            toast.error(t('backup.importFailed'));
            console.error(e);
        } finally {
            setIsLoading(false);
        }
    };

    const handleRestoreAuto = (filename: string) => {
        setPendingRestore(filename);
    };

    const confirmRestore = async () => {
        if (!pendingRestore) return;
        setIsLoading(true);
        try {
            await window.backup.restoreAutoBackup(pendingRestore);
            toast.success(t('backup.importSuccess'));
            window.location.reload();
        } catch (e) {
            toast.error(t('backup.importFailed'));
        } finally {
            setIsLoading(false);
            setPendingRestore(null);
        }
    };

    return (
        <div className="space-y-6 relative">
            <h2 className="text-xl font-bold mb-4">{t('backup.title')}</h2>

            {/* Export Card */}
            <div className="bg-surface-50 p-4 rounded-lg border border-surface-200">
                <div className="flex items-center gap-2 mb-2">
                    <Download className="w-5 h-5 text-primary-500" />
                    <h3 className="font-semibold">{t('backup.exportTitle')}</h3>
                </div>
                <p className="text-sm text-surface-500 mb-4">{t('backup.exportDesc')}</p>

                <div className="flex flex-col gap-3">
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isExportEncrypting}
                            onChange={(e) => setIsExportEncrypting(e.target.checked)}
                            className="rounded border-surface-300 text-primary-500 focus:ring-primary-500"
                        />
                        <Shield className="w-4 h-4 text-surface-500" />
                        <span className="text-sm select-none">{t('backup.encryptOption')}</span>
                    </label>

                    {isExportEncrypting && (
                        <input
                            type="password"
                            value={exportPassword}
                            onChange={(e) => setExportPassword(e.target.value)}
                            placeholder={t('backup.passwordPlaceholder')}
                            className="px-3 py-2 bg-white border border-surface-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 transition-all"
                        />
                    )}

                    <Button onClick={handleExport} disabled={isLoading} className="mt-2 w-full sm:w-auto">
                        {t('backup.exportBtn')}
                    </Button>
                </div>
            </div>

            {/* Import Card */}
            <div className="bg-surface-50 p-4 rounded-lg border border-surface-200">
                <div className="flex items-center gap-2 mb-2">
                    <Upload className="w-5 h-5 text-red-500" />
                    <h3 className="font-semibold text-red-600">{t('backup.importTitle')}</h3>
                </div>
                <p className="text-sm text-surface-500 mb-4">{t('backup.importDesc')}</p>

                <div className="flex flex-col gap-3">
                    {/* Optional Password Input for Import */}
                    <label className="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            checked={isImportEncrypting}
                            onChange={(e) => setIsImportEncrypting(e.target.checked)}
                            className="rounded border-surface-300 text-red-500 focus:ring-red-500"
                        />
                        <Shield className="w-4 h-4 text-surface-500" />
                        <span className="text-sm select-none">{t('backup.encryptOption')}</span>
                    </label>

                    {isImportEncrypting && (
                        <input
                            type="password"
                            value={importPassword}
                            onChange={(e) => setImportPassword(e.target.value)}
                            placeholder={t('backup.passwordPlaceholder')}
                            className="px-3 py-2 bg-white border border-surface-200 rounded text-sm focus:outline-none focus:ring-2 focus:ring-red-500 transition-all"
                        />
                    )}

                    <Button variant="outline" onClick={handleImport} disabled={isLoading} className="w-full sm:w-auto border-red-200 text-red-600 hover:bg-red-50 hover:text-red-700">
                        <ArchiveRestore className="w-4 h-4 mr-2" />
                        {t('backup.importBtn')}
                    </Button>
                </div>
            </div>

            {/* Auto Backups List */}
            {autoBackups.length > 0 && (
                <div className="bg-surface-50 p-4 rounded-lg border border-surface-200">
                    <div className="flex items-center gap-2 mb-2">
                        <History className="w-5 h-5 text-blue-500" />
                        <h3 className="font-semibold">{t('backup.autoTitle')}</h3>
                    </div>
                    <p className="text-sm text-surface-500 mb-4">{t('backup.autoDesc')}</p>

                    <div className="space-y-2">
                        {autoBackups.map(backup => (
                            <div key={backup.filename} className="flex items-center justify-between p-2 bg-white rounded border border-surface-100 shadow-sm">
                                <div className="flex items-center gap-3">
                                    <Clock className="w-4 h-4 text-surface-400" />
                                    <div className="flex flex-col">
                                        <span className="text-sm font-medium">
                                            {new Date(backup.createdAt).toLocaleString()}
                                        </span>
                                        <span className="text-xs text-surface-400">
                                            {(backup.size / 1024).toFixed(1)} KB
                                        </span>
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleRestoreAuto(backup.filename)}
                                    disabled={isLoading}
                                    className="text-primary-600 hover:text-primary-700 hover:bg-primary-50"
                                >
                                    {t('backup.restoreBtn')}
                                </Button>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <ConfirmModal
                isOpen={!!pendingRestore}
                onClose={() => setPendingRestore(null)}
                onConfirm={confirmRestore}
                title={t('backup.autoTitle')}
                message={t('backup.confirmRestoreAuto')}
                theme={preferences.theme}
                type="warning"
            />
        </div>
    );
};
