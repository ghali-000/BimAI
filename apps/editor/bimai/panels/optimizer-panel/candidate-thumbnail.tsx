'use client'

// Thin React wrapper over `buildThumbnail`. Maps each layer to one
// SVG element. All real work — bbox math, paint order, colour
// resolving — lives in the pure builder so vitest can exercise it
// without a DOM.
//
// Coordinate flip: the floor plan's y axis points up (math
// convention); SVG y points down. We apply a `transform="scale(1,-1)
// translate(0, -<bboxHeight*marginFactor>)"` at the group level so
// the plan reads naturally without changing the bbox math. Doing the
// flip *here* (renderer-side) means the builder stays simple and
// every test reasons in plan-space, not screen-space.

import type { BuildingPlan } from '../../generator/types'
import { unitColor } from '../../lib/unit-colors'
import { buildThumbnail, type ThumbnailLayer } from './build-thumbnail'

export function CandidateThumbnail({
  plan,
  className,
}: {
  plan: BuildingPlan
  className?: string
}) {
  const data = buildThumbnail(plan, { unitColor })
  return (
    <svg
      className={className}
      viewBox={data.viewBox}
      preserveAspectRatio="xMidYMid meet"
      xmlns="http://www.w3.org/2000/svg"
    >
      <FlipY viewBox={data.viewBox}>
        {data.layers.map((layer, i) => (
          <LayerPath key={i} layer={layer} />
        ))}
      </FlipY>
    </svg>
  )
}

function LayerPath({ layer }: { layer: ThumbnailLayer }) {
  return (
    <path
      d={layer.d}
      fill={layer.fill ?? 'none'}
      stroke={layer.stroke ?? 'none'}
      strokeWidth={layer.strokeWidth}
      // Keep the wall edge a thin hairline regardless of card size.
      vectorEffect="non-scaling-stroke"
      strokeLinejoin="miter"
    />
  )
}

/**
 * Group wrapper that flips the y axis around the viewBox's vertical
 * mid-line. Lets us keep building coordinates in math-space (y-up)
 * while letting SVG render with its native y-down convention.
 */
function FlipY({
  viewBox,
  children,
}: {
  viewBox: string
  children: React.ReactNode
}) {
  // viewBox = "x y w h" — translate by 2y+h so flipping y around
  // origin lands the plan back inside the viewBox.
  const [, y, , h] = viewBox.split(' ').map(Number)
  const ty = (y ?? 0) * 2 + (h ?? 0)
  return (
    <g transform={`matrix(1 0 0 -1 0 ${ty})`}>{children}</g>
  )
}
