import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BlackboardClient } from '../src/blackboard/client.js';

const fakeServer = fileURLToPath(new URL('./fixtures/fake-bb-server.mjs', import.meta.url));

describe('BlackboardClient (real MCP stdio transport, fake server)', () => {
  afterEach(() => {
    delete process.env.FAKE_BB_MODE;
  });

  it('calls get_upcoming_work and list_courses and validates their shape', async () => {
    const client = await BlackboardClient.connect({ serverPath: fakeServer });
    try {
      const work = await client.getUpcomingWork(14);
      expect(work.window?.days).toBe(14);
      expect(work.items).toHaveLength(3);
      expect(work.items[0]).toMatchObject({ ref: '_26184_1:_3010_1', title: 'HW 3' });
      const courses = await client.listCourses();
      expect(courses.courses[0]?.course_code).toBe('CIS.473.M001.FALL2026');
    } finally {
      await client.close();
    }
  });

  it('maps BLACKBOARD_SESSION_EXPIRED to a blackboard_auth error', async () => {
    process.env.FAKE_BB_MODE = 'expired';
    const client = await BlackboardClient.connect({ serverPath: fakeServer });
    try {
      await expect(client.getUpcomingWork(7)).rejects.toMatchObject({ kind: 'blackboard_auth' });
    } finally {
      await client.close();
    }
  });

  it('reports a missing server path as a config error', async () => {
    await expect(BlackboardClient.connect({ serverPath: '/nope/dist/index.js' })).rejects.toMatchObject({ kind: 'config' });
  });
});
