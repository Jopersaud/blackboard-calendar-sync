import { z } from 'zod';

/**
 * Response shapes of the blackboard-mcp tools we use, confirmed against its
 * source (src/tools/student.ts, src/tools/courses.ts). Schemas are lenient
 * (passthrough, optional fields) so an added field upstream never breaks a
 * sync; only what we actually rely on is required.
 */

export const UpcomingItemSchema = z
  .object({
    /** "<courseId>:<contentId>" — or "<courseId>:<title-slug>" when Blackboard gave no content id. */
    ref: z.string().min(1),
    course_id: z.string().min(1),
    course_name: z.string().optional().nullable(),
    title: z.string().min(1),
    /** ISO 8601, always UTC (blackboard-mcp normalizes with toISOString()). */
    due_date: z.string().optional().nullable(),
    points_possible: z.number().optional().nullable(),
    status: z.string().optional().nullable(),
    category: z.string().optional().nullable(),
  })
  .passthrough();

export type UpcomingItem = z.infer<typeof UpcomingItemSchema>;

export const UpcomingWorkSchema = z
  .object({
    window: z.object({ from: z.string(), until: z.string(), days: z.number() }).partial().optional(),
    count: z.number().optional(),
    items: z.array(UpcomingItemSchema),
    recently_overdue: z.array(UpcomingItemSchema).optional(),
    limitations: z.array(z.string()).optional(),
  })
  .passthrough();

export type UpcomingWork = z.infer<typeof UpcomingWorkSchema>;

export const CourseSchema = z
  .object({
    course_id: z.string(),
    name: z.string().optional().nullable(),
    /** Blackboard external course key, e.g. "CIS.473.M001.FALL2026". */
    course_code: z.string().optional().nullable(),
  })
  .passthrough();

export const CourseListSchema = z.object({ courses: z.array(CourseSchema) }).passthrough();

export type CourseList = z.infer<typeof CourseListSchema>;
