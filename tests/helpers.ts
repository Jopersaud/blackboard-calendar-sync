import fs from 'node:fs';
import { parseConfig, type Config } from '../src/config.js';
import { CourseListSchema, UpcomingWorkSchema, type CourseList, type UpcomingWork } from '../src/blackboard/schema.js';

const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

export const upcomingFixture = (): UpcomingWork => UpcomingWorkSchema.parse(fixture('upcoming-work.json'));
export const coursesFixture = (): CourseList => CourseListSchema.parse(fixture('courses.json'));

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return parseConfig({ blackboardMcpPath: '/nowhere/dist/index.js', timeZone: 'America/New_York', ...overrides });
}
