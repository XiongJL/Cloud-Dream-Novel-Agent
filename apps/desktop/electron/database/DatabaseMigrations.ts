import type { DatabaseMigration } from './DatabaseLifecycle';

export const DATABASE_MIGRATIONS: DatabaseMigration[] = [
    {
        version: 2,
        name: 'agent-message-sequence-unique-index',
        checksum: 'agent-message-sequence-unique-index-v1',
        up: async (database) => {
            const invalidSequences = await database.$queryRawUnsafe<Array<{ id: string }>>(`
                SELECT id
                FROM AgentMessage
                WHERE sequence IS NULL OR sequence < 1
                LIMIT 1
            `);
            if (invalidSequences.length > 0) {
                throw new Error(
                    `Cannot migrate AgentMessage: invalid sequence on message ${invalidSequences[0].id}. ` +
                    'Reset the development database before retrying.',
                );
            }
            const duplicates = await database.$queryRawUnsafe<Array<{ conversationId: string; sequence: number; count: number }>>(`
                SELECT conversationId, sequence, COUNT(*) AS count
                FROM AgentMessage
                GROUP BY conversationId, sequence
                HAVING COUNT(*) > 1
                LIMIT 1
            `);
            if (duplicates.length > 0) {
                const duplicate = duplicates[0];
                throw new Error(
                    `Cannot migrate AgentMessage: duplicate sequence ${duplicate.sequence} in conversation ${duplicate.conversationId}. ` +
                    'Reset the development database before retrying.',
                );
            }
            await database.$executeRawUnsafe(
                'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_message_conversation_sequence ON AgentMessage(conversationId, sequence)',
            );
        },
    },
];
