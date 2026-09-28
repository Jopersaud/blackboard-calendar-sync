import { describe, expect, it } from 'vitest';
import { normalizeUpcomingWork, shortCourseCode } from '../src/normalize.js';
import { coursesFixture, upcomingFixture } from './helpers.js';

describe('shortCourseCode', () => {
  it.each([
    ['CIS.473.M001.FALL2026', 'CIS 473'],
    ['MAT-295-M003', 'MAT 295'],
    ['PSY 205', 'PSY 205'],
    ['ecs102.m002', 'ECS 102'],
    ['SANDBOX-ETHICS', undefined],
    ['', undefined],
    [null, undefined],
  ])('%s → %s', (key, expected) => {
    expect(shortCourseCode(key)).toBe(expected);
  });
});

describe('normalizeUpcomingWork', () => {
  it('flattens upcoming + recently overdue, with course codes, sorted by due date', () => {
    const out = normalizeUpcomingWork(upcomingFixture(), coursesFixture());
    expect(out.map((a) => a.title)).toEqual(['Reading Response 3', 'HW 3', 'Quiz 2', 'Reading Response 4']);
    expect(out[1]).toEqual({
      contentId: '_26184_1:_3010_1',
      courseId: '_26184_1',
      courseName: 'Operating Systems',
      courseCode: 'CIS 473',
      title: 'HW 3',
      dueAt: '2026-10-01T03:59:00.000Z',
      pointsPossible: 50,
    });
    expect(out.find((a) => a.title === 'Reading Response 4')?.courseCode).toBeUndefined();
  });

  it('can leave out recently overdue work', () => {
    const out = normalizeUpcomingWork(upcomingFixture(), coursesFixture(), { includeRecentlyOverdue: false });
    expect(out.map((a) => a.title)).not.toContain('Reading Response 3');
  });

  it('skips items without a usable due date and dedupes by ref', () => {
    const work = upcomingFixture();
    work.items.push({ ...work.items[0]! }, { ...work.items[0]!, ref: 'x:none', due_date: null }, { ...work.items[0]!, ref: 'x:bad', due_date: 'soon' });
    const out = normalizeUpcomingWork(work);
    expect(out.filter((a) => a.contentId === '_26184_1:_3010_1')).toHaveLength(1);
    expect(out.map((a) => a.contentId)).not.toContain('x:none');
    expect(out.map((a) => a.contentId)).not.toContain('x:bad');
  });

  it('works without a course list', () => {
    const out = normalizeUpcomingWork(upcomingFixture());
    expect(out.every((a) => a.courseCode === undefined)).toBe(true);
  });
});
