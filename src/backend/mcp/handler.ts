// MCP Streamable HTTP endpoint and pairing routes (SPECIFICATION.md §4, §8.1; T14).
import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { McpToolName } from '../../contracts/mcp.ts';
import { DomainError } from '../api/errors.ts';
import {
  approvePairing,
  createPairingCode,
  listExternalMcpTokens,
  mintManagedMcpToken,
  revokeMcpToken,
  validateMcpToken,
} from './tokens.ts';
import { executeMcpTool } from './tools.ts';

const TOOL_DEFINITIONS: Record<
  McpToolName,
  { name: McpToolName; description: string; inputSchema: Record<string, unknown> }
> = {
  list_tasks: {
    name: 'list_tasks',
    description: 'List accessible tasks (for managed agents: current task and its children)',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['todo', 'processing', 'hitl', 'done', 'error', 'cancelled'],
        },
        limit: { type: 'number' },
        offset: { type: 'number' },
      },
    },
  },
  get_task: {
    name: 'get_task',
    description: 'Get details of a task by ID (for managed agents: self, parent, or children)',
    inputSchema: {
      type: 'object',
      properties: { taskId: { type: 'string' } },
      required: ['taskId'],
    },
  },
  create_task: {
    name: 'create_task',
    description:
      'Create a task. Managed agents create a child under the current task (depth 0 ceiling, ' +
      'max 5 children, repo inherited from the parent). External callers MUST supply repoId ' +
      '(one of their authorized repos) and idempotencyKey; omitted repoId is rejected, unknown ' +
      'repoId is not-found, and a repoId outside the token scope is forbidden.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        idempotencyKey: { type: 'string' },
        repoId: { type: 'string' },
      },
      required: ['title'],
    },
  },
  get_messages: {
    name: 'get_messages',
    description: 'Read conversation messages for current task',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        cursor: { type: 'string' },
      },
    },
  },
  post_message: {
    name: 'post_message',
    description: 'Append an agent message to the conversation of current task',
    inputSchema: {
      type: 'object',
      properties: { content: { type: 'string' } },
      required: ['content'],
    },
  },
  request_input: {
    name: 'request_input',
    description: 'Request human-in-the-loop (HITL) input from the user in chat',
    inputSchema: {
      type: 'object',
      properties: { question: { type: 'string' } },
      required: ['question'],
    },
  },
  yield_task: {
    name: 'yield_task',
    description:
      'Managed-only: yield parent execution to wait on child tasks until terminal completion',
    inputSchema: {
      type: 'object',
      properties: {
        childTaskIds: { type: 'array', items: { type: 'string' } },
        reason: { type: 'string' },
      },
    },
  },
};

const ApprovePairingInputSchema = z.object({
  pairingCode: z.string().min(1),
  clientName: z.string().min(1),
  allowedTools: z.array(z.string()).min(1),
  allowedRepoIds: z.array(z.string()).optional(),
  allowedTaskIds: z.array(z.string()).optional(),
});

export function mountMcpRoutes(app: Hono, db: Database): void {
  // Public/Settings pairing management routes
  app.post('/api/mcp/pair', (c) => {
    const pairing = createPairingCode(db);
    return c.json(pairing, 201);
  });

  app.post('/api/mcp/approve-pairing', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = ApprovePairingInputSchema.safeParse(body);
    if (!parsed.success) {
      throw new DomainError(
        'VALIDATION_ERROR',
        'invalid approve-pairing input',
        parsed.error.flatten(),
      );
    }
    const token = approvePairing(db, parsed.data.pairingCode, {
      clientName: parsed.data.clientName,
      allowedTools: parsed.data.allowedTools as McpToolName[],
      allowedRepoIds: parsed.data.allowedRepoIds,
      allowedTaskIds: parsed.data.allowedTaskIds,
    });
    return c.json(token, 201);
  });

  app.get('/api/mcp/tokens', (c) => {
    return c.json(listExternalMcpTokens(db));
  });

  app.post('/api/mcp/tokens/:id/revoke', (c) => {
    revokeMcpToken(db, c.req.param('id'));
    return c.json({ ok: true, revokedId: c.req.param('id') });
  });

  // Internal route to mint a managed token for engine
  app.post('/internal/v1/runs/:id/mcp-token', (c) => {
    const runId = c.req.param('id');
    const runRow = db.query('SELECT task_id FROM runs WHERE id = ?').get(runId) as {
      task_id: string;
    } | null;
    if (!runRow) {
      throw new DomainError('NOT_FOUND', `run not found: ${runId}`);
    }
    return c.json(mintManagedMcpToken(db, runId, runRow.task_id), 201);
  });

  // Main `/mcp` Streamable HTTP endpoint
  app.post('/mcp', async (c) => {
    // 1. Authenticate bearer token or query token
    const authHeader = c.req.header('Authorization');
    const queryToken = c.req.query('token');
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : queryToken;

    if (!token) {
      const pairing = createPairingCode(db);
      return c.json(
        {
          code: 'UNAUTHORIZED',
          message: 'Pairing required',
          pairingCode: pairing.code,
          expiresAt: pairing.expiresAt,
        },
        401,
      );
    }

    const authContext = validateMcpToken(db, token);
    if (!authContext) {
      const pairing = createPairingCode(db);
      return c.json(
        {
          code: 'UNAUTHORIZED',
          message: 'Pairing required',
          pairingCode: pairing.code,
          expiresAt: pairing.expiresAt,
        },
        401,
      );
    }

    const rawBody = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!rawBody || typeof rawBody !== 'object') {
      throw new DomainError('VALIDATION_ERROR', 'invalid JSON request body');
    }

    // No client field/header can attest process exit (specs/2026-10-24
    // -handoff-single-writer.md contract table): a forged/absent/true
    // `x-verified-stopped` header is deliberately never read here.

    // 2. Handle JSON-RPC 2.0 messages
    if (rawBody.jsonrpc === '2.0' && typeof rawBody.method === 'string') {
      const id = rawBody.id ?? null;
      const method = rawBody.method;

      if (method === 'initialize') {
        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'taskaside', version: '0.1.0' },
          },
        });
      }

      if (method === 'notifications/initialized') {
        return c.json({ jsonrpc: '2.0', result: {} });
      }

      if (method === 'tools/list') {
        const tools = Object.values(TOOL_DEFINITIONS).filter((tool) =>
          authContext.allowedTools.has(tool.name),
        );
        return c.json({ jsonrpc: '2.0', id, result: { tools } });
      }

      if (method === 'tools/call') {
        const params = (rawBody.params ?? {}) as {
          name?: string;
          arguments?: Record<string, unknown>;
        };
        const toolName = (params.name ?? '') as McpToolName;

        const result = executeMcpTool(db, authContext, toolName, params.arguments ?? {});

        return c.json({
          jsonrpc: '2.0',
          id,
          result: {
            content: [
              {
                type: 'text',
                text: typeof result === 'string' ? result : JSON.stringify(result),
              },
            ],
          },
        });
      }

      throw new DomainError('VALIDATION_ERROR', `unsupported JSON-RPC method: ${method}`);
    }

    // 3. Direct tool call format ({ name, arguments } or { tool, params })
    const toolName = (rawBody.name ?? rawBody.tool) as McpToolName;
    const toolArgs = (rawBody.arguments ?? rawBody.params ?? {}) as Record<string, unknown>;

    if (!toolName) {
      throw new DomainError('VALIDATION_ERROR', 'missing tool name');
    }

    const result = executeMcpTool(db, authContext, toolName, toolArgs);
    return c.json({ ok: true, result });
  });
}
