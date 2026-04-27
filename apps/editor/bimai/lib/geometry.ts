// Area + perimeter for a 2D polygon (XZ plane in Pascal's coordinate system).
// Copied from packages/editor/src/components/ui/sidebar/panels/site-panel/index.tsx
// because the helpers there are not exported. If Pascal exports them upstream
// later, swap to the import.

export function calculatePerimeter(points: Array<[number, number]>): number {
  if (points.length < 2) return 0
  let perimeter = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    if (!(a && b)) continue
    perimeter += Math.sqrt((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2)
  }
  return perimeter
}

export function calculatePolygonArea(polygon: Array<[number, number]>): number {
  if (polygon.length < 3) return 0
  let area = 0
  const n = polygon.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    const a = polygon[i]
    const b = polygon[j]
    if (!(a && b)) continue
    area += a[0] * b[1]
    area -= b[0] * a[1]
  }
  return Math.abs(area) / 2
}
