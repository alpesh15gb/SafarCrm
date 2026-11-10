// Shape of public.case_readiness(): what still stands between a case and "Completed".
//   blockers   required work (blocking tasks, ticket imports awaiting review, required documents). Only the boss can override.
//   loose_ends money and booking items that need a reason to close past (any staff member who can see the case).
//   optional   open follow-ups that never block.

export type ReadinessItem = { code: string; count: number; text: string; amount?: number };
export type Readiness = { blockers: ReadinessItem[]; loose_ends: ReadinessItem[]; optional: ReadinessItem[] };

/** Required items first, then loose ends; optional follow-ups are never listed as reasons not to close. */
export function readinessText(r: Readiness | null | undefined): string[] {
  if (!r) return [];
  return [...(r.blockers ?? []), ...(r.loose_ends ?? [])].map((x) => x.text);
}

export const hasBlockers = (r: Readiness | null | undefined) => !!r && (r.blockers ?? []).length > 0;
