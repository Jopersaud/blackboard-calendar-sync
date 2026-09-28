import type { CourseList, UpcomingItem, UpcomingWork } from './blackboard/schema.js';

/** The flat internal shape every later stage works with. */
export interface Assignment {
  /** Stable Blackboard reference ("<courseId>:<contentId>"); the key for dedup and event IDs. */
  contentId: string;
  courseId: string;
  courseName?: string;
  /** Short display code like "CIS 473", when one can be derived cleanly. */
  courseCode?: string;
  title: string;
  /** Due instant, ISO 8601 UTC. */
  dueAt: string;
  pointsPossible?: number;
}

/**
 * Turn a Blackboard course key or name into a short display code:
 * "CIS.473.M001.FALL2026" → "CIS 473", "MAT-295-M003" → "MAT 295",
 * "CSE/ELE.400.MERGED.SPRING26.Intelligent Robotics" → "CSE/ELE 400".
 * Returns undefined when it doesn't start with SUBJECT + NUMBER, in which
 * case events are titled with the assignment title alone.
 */
export function shortCourseCode(courseKey: string | null | undefined): string | undefined {
  if (!courseKey) return undefined;
  const m = /^([A-Za-z]{2,5}(?:\/[A-Za-z]{2,5})*)[.\s_-]?(\d{3,4}[A-Za-z]?)(?:\b|[.\s_-])/.exec(`${courseKey.trim()} `);
  return m ? `${m[1]!.toUpperCase()} ${m[2]!.toUpperCase()}` : undefined;
}

/**
 * The human part of a Syracuse-style course name:
 * "CSE.581.M001.FALL26.Intro D/Base Mngmt Syst." → "Intro D/Base Mngmt Syst.".
 * Other names are returned unchanged.
 */
export function courseTitle(courseName: string): string {
  const m = /^[A-Za-z/]{2,11}\.\d{3,4}[A-Za-z]?\.[A-Za-z0-9]+\.[A-Za-z]+\d{2,4}\.(.+)$/.exec(courseName.trim());
  return (m?.[1] ?? courseName).trim();
}

export function courseCodeMap(courses: CourseList | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of courses?.courses ?? []) {
    const code = shortCourseCode(c.course_code);
    if (code) map.set(c.course_id, code);
  }
  return map;
}

function toAssignment(item: UpcomingItem, codes: Map<string, string>): Assignment | undefined {
  if (!item.due_date) return undefined;
  const due = new Date(item.due_date);
  if (Number.isNaN(due.getTime())) return undefined;
  const a: Assignment = {
    contentId: item.ref,
    courseId: item.course_id,
    title: item.title.trim(),
    dueAt: due.toISOString(),
  };
  if (item.course_name) a.courseName = courseTitle(item.course_name);
  // Syracuse's course keys are numeric ("21058.1271"); the subject and
  // number live in the course name instead, so fall back to that.
  const code = codes.get(item.course_id) ?? shortCourseCode(item.course_name);
  if (code) a.courseCode = code;
  if (typeof item.points_possible === 'number') a.pointsPossible = item.points_possible;
  return a;
}

/**
 * Flatten get_upcoming_work output into assignments: skip anything without a
 * usable due date, and dedupe by content reference (an item can in principle
 * appear in both the upcoming and recently-overdue lists).
 */
export function normalizeUpcomingWork(
  work: UpcomingWork,
  courses?: CourseList,
  opts: { includeRecentlyOverdue?: boolean } = {},
): Assignment[] {
  const codes = courseCodeMap(courses);
  const raw = [...work.items, ...(opts.includeRecentlyOverdue === false ? [] : (work.recently_overdue ?? []))];
  const byId = new Map<string, Assignment>();
  for (const item of raw) {
    const a = toAssignment(item, codes);
    if (a && !byId.has(a.contentId)) byId.set(a.contentId, a);
  }
  return [...byId.values()].sort((x, y) => x.dueAt.localeCompare(y.dueAt) || x.contentId.localeCompare(y.contentId));
}
