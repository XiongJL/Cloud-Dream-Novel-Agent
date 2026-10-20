export type McpServerStatus = {
    enabled: boolean;
    state: 'disabled' | 'starting' | 'running' | 'error';
    port: number;
    url: string;
    token?: string;
    error?: string;
};
