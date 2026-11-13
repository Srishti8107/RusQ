/**
 * Team assignments: the control room sends a team to a specific location with a priority.
 * The location can be a priority area from decision support, a point picked on the map, or
 * typed coordinates. The team sees its assignments highest priority first and reports
 * progress (on the way → done).
 */
import { z } from 'zod';

export const ASSIGNMENT_PRIORITIES = ['critical', 'high', 'medium', 'low'] as const;
export type AssignmentPriority = (typeof ASSIGNMENT_PRIORITIES)[number];
export const PRIORITY_RANK: Record<AssignmentPriority, number> = { critical: 0, high: 1, medium: 2, low: 3 };
export const PRIORITY_LABEL: Record<AssignmentPriority, string> = { critical: 'Critical', high: 'High', medium: 'Medium', low: 'Low' };

export const ASSIGNMENT_STATUSES = ['assigned', 'in_progress', 'done', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];
export const STATUS_LABEL: Record<AssignmentStatus, string> = { assigned: 'Assigned', in_progress: 'On the way / working', done: 'Done', cancelled: 'Cancelled' };

export const AssignmentInput = z.object({
  teamId: z.string().trim().min(1).max(64),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  place: z.string().trim().min(1, 'give the place a short name').max(120),
  priority: z.enum(ASSIGNMENT_PRIORITIES),
  instructions: z.string().trim().max(1000).default(''),
  /** decision-support area this came from, if any */
  cellId: z.string().max(64).nullable().default(null),
});
export type AssignmentInput = z.infer<typeof AssignmentInput>;

export const AssignmentUpdate = z
  .object({
    teamId: z.string().trim().min(1).max(64).optional(),
    priority: z.enum(ASSIGNMENT_PRIORITIES).optional(),
    status: z.enum(ASSIGNMENT_STATUSES).optional(),
    instructions: z.string().trim().max(1000).optional(),
  })
  .refine((u) => Object.values(u).some((v) => v !== undefined), 'nothing to change');
export type AssignmentUpdate = z.infer<typeof AssignmentUpdate>;

/** What a team itself may report. */
export const TeamAssignmentUpdate = z.object({
  status: z.enum(['in_progress', 'done']),
  note: z.string().trim().max(500).optional(),
});

export interface Assignment extends AssignmentInput {
  id: string;
  serverId: string;
  status: AssignmentStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  updatedBy: string;
  teamNote: string | null;
}

export function isActive(a: Pick<Assignment, 'status'>): boolean {
  return a.status === 'assigned' || a.status === 'in_progress';
}

/** Active first, then highest priority, then oldest first (it has waited longest). */
export function sortAssignments<T extends Pick<Assignment, 'status' | 'priority' | 'createdAt' | 'serverId'>>(list: readonly T[]): T[] {
  return [...list].sort(
    (a, b) =>
      Number(isActive(b)) - Number(isActive(a)) ||
      PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.serverId.localeCompare(b.serverId),
  );
}

/** A team may move its own assignment forward only: assigned → in progress → done (or straight to done). */
export function teamMayMove(from: AssignmentStatus, to: 'in_progress' | 'done'): boolean {
  return (from === 'assigned' && (to === 'in_progress' || to === 'done')) || (from === 'in_progress' && to === 'done');
}
