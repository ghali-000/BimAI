'use client'

import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { useActiveSiteEnvelopeData } from '../../lib/use-active-site-envelope-data'

const FILL_COLOR = '#3b82f6'
const FILL_OPACITY = 0.15
const OUTLINE_COLOR = '#3b82f6'
const Y_OFFSET = 0.02

interface EnvelopeObjects {
  fillGeometry: THREE.ShapeGeometry
  outlineGeometry: THREE.BufferGeometry
  fillMaterial: THREE.MeshBasicMaterial
  outlineMaterial: THREE.LineDashedMaterial
  outline: THREE.Line
}

function buildObjects(polygon: [number, number][]): EnvelopeObjects | null {
  if (polygon.length < 3) return null

  const shape = new THREE.Shape(
    polygon.map(([x, z]) => new THREE.Vector2(x, z)),
  )
  const fillGeometry = new THREE.ShapeGeometry(shape)
  // ShapeGeometry lays the shape on the XY plane; rotate so it lies on XZ
  // (Pascal's ground plane).
  fillGeometry.rotateX(-Math.PI / 2)

  const outlinePoints: THREE.Vector3[] = polygon.map(
    ([x, z]) => new THREE.Vector3(x, 0, z),
  )
  if (outlinePoints[0]) outlinePoints.push(outlinePoints[0].clone())
  const outlineGeometry = new THREE.BufferGeometry().setFromPoints(outlinePoints)

  const fillMaterial = new THREE.MeshBasicMaterial({
    color: FILL_COLOR,
    transparent: true,
    opacity: FILL_OPACITY,
    depthWrite: false,
    side: THREE.DoubleSide,
  })

  const outlineMaterial = new THREE.LineDashedMaterial({
    color: OUTLINE_COLOR,
    dashSize: 0.4,
    gapSize: 0.25,
    linewidth: 1,
  })

  const outline = new THREE.Line(outlineGeometry, outlineMaterial)
  outline.computeLineDistances()
  outline.renderOrder = 2

  return {
    fillGeometry,
    outlineGeometry,
    fillMaterial,
    outlineMaterial,
    outline,
  }
}

export function EnvelopeRenderer() {
  const { envelope } = useActiveSiteEnvelopeData()
  const polygon = envelope?.ok ? envelope.polygon : null

  const objects = useMemo<EnvelopeObjects | null>(() => {
    if (!polygon) return null
    return buildObjects(polygon)
  }, [polygon])

  useEffect(() => {
    if (!objects) return
    return () => {
      objects.fillGeometry.dispose()
      objects.outlineGeometry.dispose()
      objects.fillMaterial.dispose()
      objects.outlineMaterial.dispose()
    }
  }, [objects])

  if (!objects) return null

  return (
    <group position={[0, Y_OFFSET, 0]}>
      <mesh
        geometry={objects.fillGeometry}
        material={objects.fillMaterial}
        renderOrder={1}
      />
      <primitive object={objects.outline} />
    </group>
  )
}
