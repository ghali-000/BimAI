// Cost compute contract.
//
// Hybrid model: per-component sum-of-products for the modelled bits
// (walls, slabs, doors, windows) PLUS additive typology categories
// (MEP, finishes, general conditions, contingency, soft costs) computed
// from GEA. Two aggregate totals — `hardCost` and `totalProjectCost` —
// match the architechtures.com presentation:
//
//   ABOVE GRADE (per-component + typology except softCosts) → HARD COST
//   HARD COST + SOFT COSTS                                  → TOTAL PROJECT COST
//
// All amounts are in EUR. The cost panel formats with `Intl.NumberFormat`;
// computation keeps numbers raw.

export interface CostByWallCategory {
  /** Walls whose material id is in the catalog's "exterior" set
   *  (brick-exterior, concrete-precast-facade). */
  exterior: number
  /** Walls that are neither exterior nor explicitly load-bearing. */
  interior: number
  /** Walls with `metadata.bimai.bim.loadBearing === true` AND not in the
   *  exterior bucket. Buckets are disjoint: every wall lands in exactly
   *  one of exterior / loadBearing / interior so the three sum to the
   *  per-component wall total. */
  loadBearing: number
}

export interface CostByOpeningCategory {
  doors: number
  windows: number
}

export interface CostPerComponent {
  walls: CostByWallCategory
  slabs: number
  openings: CostByOpeningCategory
  /** Phase 3-8 Task 8. Sum of stair-segment costs (treads + landings).
   *  Priced as surface area × concrete €/m² — `bim-defaults` does not stamp
   *  stair segments today, so the cost layer falls back to the catalog's
   *  `concrete-cast` price unless the segment carries an explicit
   *  `costOverride.perM2`. Broken out separately so the user can audit
   *  what egress cores contribute to the build. */
  stairs: number
}

export interface CostTypology {
  mep: number
  finishes: number
  generalConditions: number
  /** Computed as `contingencyPct × (perComponent + mep + finishes + generalConditions)`. */
  contingency: number
}

export interface CostResult {
  perComponent: CostPerComponent
  /** Sum of every per-component bucket. */
  perComponentTotal: number

  typology: CostTypology
  /** Sum of every typology bucket (excluding soft costs). */
  typologyTotal: number

  /** perComponentTotal + typologyTotal. */
  hardCost: number
  /** softCostsPct × hardCost. */
  softCosts: number
  /** hardCost + softCosts. */
  totalProjectCost: number

  /** totalProjectCost ÷ GEA. 0 when GEA is 0. */
  perM2OfGEA: number
  /** totalProjectCost ÷ unitCount. 0 when unitCount is 0. */
  perUnit: number

  /** Non-fatal observations — e.g. "wall X has no material, used catalog default". */
  warnings: string[]
}
