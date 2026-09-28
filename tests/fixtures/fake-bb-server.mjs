// A stand-in for blackboard-mcp's dist/index.js: same tool names and
// result conventions, canned data. FAKE_BB_MODE=expired simulates a lapsed session.
import fs from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const here = new URL('.', import.meta.url);
const read = (f) => fs.readFileSync(new URL(f, here), 'utf8');
const server = new McpServer({ name: 'fake-blackboard-mcp', version: '0.0.0' });
const expired = process.env.FAKE_BB_MODE === 'expired';
const fail = { content: [{ type: 'text', text: 'BLACKBOARD_SESSION_EXPIRED: The Blackboard sign-in has expired.' }], isError: true };

server.registerTool('get_upcoming_work', { inputSchema: { days: z.number().optional() } }, async ({ days }) => {
  if (expired) return fail;
  const data = JSON.parse(read('upcoming-work.json'));
  data.window.days = days;
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
});
server.registerTool('list_courses', { inputSchema: {} }, async () =>
  expired ? fail : { content: [{ type: 'text', text: read('courses.json') }] },
);

await server.connect(new StdioServerTransport());
