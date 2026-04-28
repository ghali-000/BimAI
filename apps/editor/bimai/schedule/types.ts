// Schedule contracts. Type-only — no runtime code lives here.
//
// "Schedule" in the BIM sense: the area / unit-count breakdown that drops
// out of a generated building. Inputs are nodes from a scene snapshot;
// outputs are the numbers shown in the Schedule panel and reused by
// `cost/compute.ts` (typology categories multiply €/m² × GEA, so the
// schedule's GEA is authoritative — cost MUST NOT recompute area itself).
//
// Vocabulary (sticking to RICS / IPMS conventions):
//   GEA — Gross External Area. Floor area measured to the outer face of
//         the perimeter walls. We approximate this as the slab polygon
//         area on each level, which matches by construction (slab outline
//         == footprint).
//   NIA — Net Internal Area. Usable floor area inside the unit envelope,
//         excluding shared circulation (corridors), structure, MEP shafts.
//         We approximate this as the sum of zone polygon areas on each
//         level — corridors are not zones in our generator, so the sum
//         lines up with the AEC definition closely enough for Phase 3-4.
//   Efficiency — NIA ÷ GEA. 1.0 = no overhead (impossible); 0.7-0.85 is
//                healthy mid-rise residential, 0.6 is corridor-heavy.
//
// Per-unit-type breakdown is keyed off each ZoneNode's
// `metadata.bimai.unitType` (set by the zone emitter). A zone with no
// `unitType` is bucketed under '(unknown)' rather than dropped — the
// numbers still need to add up.

export interface ScheduleByFloor {
  /** 0 = ground floor. Matches LevelNode.level. */
  level: number
  gea: number
  nia: number
  unitCount: number
}

export interface ScheduleByUnitType {
  /** Verbatim from the zone's metadata.bimai.unitType (e.g. "1BR"). */
  type: string
  count: number
  totalArea: number
  /** totalArea ÷ count. 0 when count is 0 (defensive — shouldn't happen). */
  avgArea: number
}

export interface ScheduleTotals {
  gea: number
  nia: number
  /** NIA ÷ GEA; 0 when GEA is 0 (no division by zero). */
  efficiency: number
}

export interface ScheduleResidential {
  totalUnits: number
  /** totalNIA ÷ totalUnits; 0 when totalUnits is 0. */
  avgUnitArea: number
  /** Sorted by `count` desc, then `type` asc for stable display. */
  byUnitType: ScheduleByUnitType[]
}

export interface ScheduleResult {
  /** Number of LevelNodes counted. */
  floorCount: number
  totals: ScheduleTotals
  /** Sorted by `level` asc. */
  byFloor: ScheduleByFloor[]
  residential: ScheduleResidential
  /** Non-fatal observations — e.g. "level N has no slab", "zone X has no unitType". */
  warnings: string[]
}
