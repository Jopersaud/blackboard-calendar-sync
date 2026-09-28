#!/usr/bin/env node
/**
 * Print raw blackboard-mcp output (`npm run probe -- --days 14`), to check
 * the real response shape against src/blackboard/schema.ts.
 */
import { flagValue, hasFlag } from './app.js';
import { BlackboardClient } from './blackboard/client.js';
import { loadConfig } from './config.js';
import { errorMessage } from './errors.js';
import { normalizeUpcomingWork } from './normalize.js';
import { UpcomingWorkSchema, CourseListSchema } from './blackboard/schema.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const config = loadConfig();
  const days = Number(flagValue(args, '--days') ?? config.lookaheadDays);
  const client = await BlackboardClient.connect({
    serverPath: config.blackboardMcpPath,
    ...(config.nodePath ? { nodePath: config.nodePath } : {}),
    stderr: 'inherit',
  });
  try {
    const upcomingText = await client.callToolText('get_upcoming_work', { days });
    process.stdout.write(`--- get_upcoming_work (days=${days}) ---\n${upcomingText}\n`);
    const coursesText = await client.callToolText('list_courses');
    process.stdout.write(`--- list_courses ---\n${coursesText}\n`);
    if (hasFlag(args, '--normalized')) {
      const normalized = normalizeUpcomingWork(
        UpcomingWorkSchema.parse(JSON.parse(upcomingText)),
        CourseListSchema.parse(JSON.parse(coursesText)),
        { includeRecentlyOverdue: config.includeRecentlyOverdue },
      );
      process.stdout.write(`--- normalized ---\n${JSON.stringify(normalized, null, 2)}\n`);
    }
  } finally {
    await client.close();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    process.stderr.write(`${errorMessage(err)}\n`);
    process.exit(1);
  },
);
