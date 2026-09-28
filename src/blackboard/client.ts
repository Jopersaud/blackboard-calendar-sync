import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fs from 'node:fs';
import path from 'node:path';
import type { z } from 'zod';
import { SyncError, isBlackboardAuthText } from '../errors.js';
import { CourseListSchema, UpcomingWorkSchema, type CourseList, type UpcomingWork } from './schema.js';

/** get_upcoming_work resolves submission status per item, which can take a while. */
const TOOL_TIMEOUT_MS = 5 * 60_000;

/** The subset of Blackboard access the sync engine needs (faked in tests). */
export interface BlackboardSource {
  getUpcomingWork(days: number): Promise<UpcomingWork>;
  listCourses(): Promise<CourseList>;
  close(): Promise<void>;
}

export interface BlackboardClientOptions {
  /** Path to blackboard-mcp's dist/index.js. */
  serverPath: string;
  nodePath?: string;
  /** Where the server's stderr goes (it logs there). Defaults to ignoring it. */
  stderr?: 'inherit' | 'ignore' | 'pipe';
}

/**
 * An MCP client that spawns blackboard-mcp as a child process over stdio
 * and calls its tools programmatically — the same tools Claude Desktop
 * would call, invoked by our own code instead of a model.
 */
export class BlackboardClient implements BlackboardSource {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async connect(opts: BlackboardClientOptions): Promise<BlackboardClient> {
    const serverPath = path.resolve(opts.serverPath);
    if (!fs.existsSync(serverPath)) {
      throw new SyncError(
        'config',
        `blackboard-mcp not found at ${serverPath}. Build it (npm run build in blackboard-mcp) and set blackboardMcpPath in config.json.`,
      );
    }
    const transport = new StdioClientTransport({
      command: opts.nodePath ?? process.execPath,
      args: [serverPath],
      // Pass the full environment: blackboard-mcp needs HOME to find its
      // saved session and PATH/Chrome locations for Playwright.
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      cwd: path.dirname(path.dirname(serverPath)),
      stderr: opts.stderr ?? 'ignore',
    });
    const client = new Client({ name: 'blackboard-calendar-sync', version: '0.1.0' });
    await client.connect(transport);
    return new BlackboardClient(client, transport);
  }

  /** Call a tool and return its raw text payload, turning tool errors into SyncErrors. */
  async callToolText(name: string, args: Record<string, unknown> = {}): Promise<string> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      timeout: TOOL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
    });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .filter((c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
      .join('\n');
    if (result.isError) {
      if (isBlackboardAuthText(text)) {
        throw new SyncError('blackboard_auth', text.replace(/^[A-Z_]+:\s*/, ''));
      }
      throw new SyncError('other', `blackboard-mcp ${name} failed: ${text || '(no message)'}`);
    }
    return text;
  }

  private async callToolJson<T extends z.ZodTypeAny>(name: string, args: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
    const text = await this.callToolText(name, args);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SyncError('other', `blackboard-mcp ${name} returned non-JSON output: ${text.slice(0, 200)}`);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new SyncError('other', `blackboard-mcp ${name} returned an unexpected shape: ${parsed.error.message}`);
    }
    return parsed.data;
  }

  getUpcomingWork(days: number): Promise<UpcomingWork> {
    return this.callToolJson('get_upcoming_work', { days }, UpcomingWorkSchema);
  }

  listCourses(): Promise<CourseList> {
    return this.callToolJson('list_courses', {}, CourseListSchema);
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => undefined);
    await this.transport.close().catch(() => undefined);
  }
}
