import * as THREE from 'three';
import { INSOLE_CONTOURS } from '@/lib/insoleContours';

export interface ZoneSupportCompensation {
  forefoot: number;
  arch: number;
  heel: number;
}

export interface LatticeStrut {
  start: THREE.Vector3;
  end: THREE.Vector3;
}

export interface LatticeData {
  struts: LatticeStrut[];
  joints: THREE.Vector3[];
}

export interface LatticeSpec {
  cellSizeCm: number;
  strutRadiusCm: number;
  jointRadiusCm: number;
  boundaryAnchorSpacingCm: number;
}

const ZERO_COMPENSATION: ZoneSupportCompensation = { forefoot: 0, arch: 0, heel: 0 };
const MIN_PRINTABLE_STRUT_RADIUS_CM = 0.06; // 名义直径 1.2mm，6边形截面最细处约 1.04mm

export function scaleContour(
  points: readonly (readonly [number, number])[],
  footLength: number,
  footWidth: number,
  foot: 'left' | 'right'
): [number, number][] {
  const ys = points.map(p => p[1]);
  const xs = points.map(p => p[0]);
  const normH = Math.max(...ys) - Math.min(...ys);
  const normW = Math.max(...xs) - Math.min(...xs);

  const scaleY = footLength / normH;
  const scaleX = footWidth / normW;

  const minY = Math.min(...ys);
  const centerX = (Math.max(...xs) + Math.min(...xs)) / 2;
  const maxY = Math.max(...ys);

  return points.map(([x, y]) => {
    const sx = -(x - centerX) * scaleX;

    let sz: number;
    if (foot === 'left') {
      sz = -((y - minY) * scaleY - footLength / 2);
    } else {
      sz = -(((maxY - y + minY) - minY) * scaleY - footLength / 2);
    }

    return [sx, sz];
  });
}

export function pointInPolygon(px: number, py: number, polygon: [number, number][]): boolean {
  let inside = false;
  const n = polygon.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = polygon[i][0], yi = polygon[i][1];
    const xj = polygon[j][0], yj = polygon[j][1];
    if ((yi > py) !== (yj > py) && px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function getBounds(polygon: [number, number][]): { minX: number; maxX: number; minY: number; maxY: number } {
  const xs = polygon.map(p => p[0]);
  const ys = polygon.map(p => p[1]);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

export function createSmoothZoneWeight(value: number, start: number, end: number): number {
  if (value <= start || value >= end) return 0;
  const t = (value - start) / (end - start);
  return Math.sin(t * Math.PI) ** 2;
}

export function getCompensationZoneWeights(
  x: number,
  z: number,
  footLength: number,
  foot: 'left' | 'right'
): ZoneSupportCompensation {
  const normalizedZ = (-z + footLength / 2) / footLength;
  const halfWidth = footLength * 0.2;
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  const innerSide = foot === 'left' ? normalizedX : -normalizedX;

  return {
    forefoot:
      createSmoothZoneWeight(normalizedZ, 0.58, 0.92) *
      (0.75 + 0.25 * (1 - Math.abs(normalizedX))),
    arch:
      createSmoothZoneWeight(normalizedZ, 0.28, 0.56) *
      (0.4 + 0.6 * Math.max(0, innerSide)),
    heel:
      createSmoothZoneWeight(normalizedZ, 0.02, 0.32) *
      (0.8 + 0.2 * (1 - Math.abs(normalizedX))),
  };
}

export function getLocalCompensationCm(
  x: number,
  z: number,
  footLength: number,
  foot: 'left' | 'right',
  compensation: ZoneSupportCompensation = ZERO_COMPENSATION
): number {
  const weights = getCompensationZoneWeights(x, z, footLength, foot);

  return (
    (compensation.forefoot / 10) * weights.forefoot +
    (compensation.arch / 10) * weights.arch +
    (compensation.heel / 10) * weights.heel
  );
}

export function getInsoleHeight(
  x: number,
  z: number,
  footLength: number,
  archCorrection: number,
  baseThickness: number,
  foot: 'left' | 'right',
  heelThickness: number = 0,
  compensation: ZoneSupportCompensation = ZERO_COMPENSATION
): number {
  const normalizedZ = (-z + footLength / 2) / footLength;

  const archCenter = 0.42;
  const archWidth = 0.18;
  const archDist = Math.abs(normalizedZ - archCenter) / archWidth;
  const archProfile = archDist < 1 ? Math.cos(archDist * Math.PI / 2) ** 2 : 0;

  const halfWidth = footLength * 0.2;
  const normalizedX = Math.max(-1, Math.min(1, x / halfWidth));
  const rawInner = foot === 'left'
    ? (1 + normalizedX) / 2
    : (1 - normalizedX) / 2;
  const innerFactor = Math.max(0, Math.min(1, rawInner));

  const archHeight = (archCorrection / 10) * archProfile * (0.3 + 0.7 * innerFactor);

  const heelNorm = normalizedZ;
  const heelCup = heelNorm < 0.15 ? (1 - heelNorm / 0.15) * 0.15 : 0;

  const heelThickCm = heelThickness / 10;
  const heelCushionZone = 0.35;
  const heelCushion = normalizedZ < heelCushionZone
    ? heelThickCm * Math.cos(normalizedZ / heelCushionZone * Math.PI / 2) ** 2
    : 0;

  const baseHeight = baseThickness + archHeight + heelCup + heelCushion;
  const localCompensation = getLocalCompensationCm(x, z, footLength, foot, compensation);
  const minThickness = Math.max(0.12, baseThickness * 0.55);
  const adjustedHeight = baseHeight + localCompensation;

  return localCompensation >= 0 ? adjustedHeight : Math.max(minThickness, adjustedHeight);
}

export function getLatticeSpec(latticeDensity: number = 3): LatticeSpec {
  const densityToCellSize: Record<number, number> = {
    1: 1.0,
    2: 0.85,
    3: 0.65,
    4: 0.5,
    5: 0.4,
  };

  const cellSizeCm = densityToCellSize[latticeDensity] ?? densityToCellSize[3];
  const strutRadiusCm = MIN_PRINTABLE_STRUT_RADIUS_CM;
  const jointRadiusCm = MIN_PRINTABLE_STRUT_RADIUS_CM;
  const boundaryAnchorSpacingCm = Math.max(0.28, cellSizeCm * 0.7);

  return {
    cellSizeCm,
    strutRadiusCm,
    jointRadiusCm,
    boundaryAnchorSpacingCm,
  };
}

function sampleContourAnchors(contour: [number, number][], spacingCm: number): [number, number][] {
  if (contour.length <= 1) return contour;

  const segments: Array<{
    start: [number, number];
    end: [number, number];
    length: number;
  }> = [];

  let perimeter = 0;
  for (let i = 0; i < contour.length; i++) {
    const start = contour[i];
    const end = contour[(i + 1) % contour.length];
    const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
    if (length <= 1e-6) continue;
    segments.push({ start, end, length });
    perimeter += length;
  }

  if (segments.length === 0 || perimeter <= spacingCm) {
    return contour;
  }

  const anchors: [number, number][] = [];
  const steps = Math.max(3, Math.round(perimeter / spacingCm));
  for (let step = 0; step < steps; step++) {
    const targetDistance = (perimeter * step) / steps;
    let traversed = 0;

    for (const segment of segments) {
      if (targetDistance <= traversed + segment.length) {
        const localDistance = targetDistance - traversed;
        const t = segment.length === 0 ? 0 : localDistance / segment.length;
        anchors.push([
          segment.start[0] + (segment.end[0] - segment.start[0]) * t,
          segment.start[1] + (segment.end[1] - segment.start[1]) * t,
        ]);
        break;
      }
      traversed += segment.length;
    }
  }

  return anchors.length > 0 ? anchors : contour;
}

function createVectorKey(point: THREE.Vector3): string {
  return `${point.x.toFixed(4)}:${point.y.toFixed(4)}:${point.z.toFixed(4)}`;
}

function createStrutKey(start: THREE.Vector3, end: THREE.Vector3): string {
  const a = createVectorKey(start);
  const b = createVectorKey(end);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function findNearestPoints(
  target: THREE.Vector3,
  candidates: THREE.Vector3[],
  maxDistance: number,
  count: number
): THREE.Vector3[] {
  return candidates
    .map(candidate => ({
      candidate,
      distance: candidate.distanceTo(target),
    }))
    .filter(item => item.distance > 0.01 && item.distance <= maxDistance)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map(item => item.candidate);
}

export function generateLatticeData(
  foot: 'left' | 'right',
  footLength: number,
  footWidth: number,
  archCorrection: number,
  baseThickness: number,
  heelThickness: number = 0,
  latticeDensity: number = 3,
  compensation: ZoneSupportCompensation = ZERO_COMPENSATION
): LatticeData {
  const spec = getLatticeSpec(latticeDensity);
  const outerRaw = foot === 'left' ? INSOLE_CONTOURS.leftOuter : INSOLE_CONTOURS.rightOuter;
  const outerContour = scaleContour(outerRaw, footLength, footWidth, foot);
  const bounds = getBounds(outerContour);

  const rows = Math.ceil((bounds.maxY - bounds.minY) / spec.cellSizeCm);
  const cols = Math.ceil((bounds.maxX - bounds.minX) / spec.cellSizeCm);

  const struts: LatticeStrut[] = [];
  const joints: THREE.Vector3[] = [];
  const strutKeys = new Set<string>();
  const jointKeys = new Set<string>();

  const addJoint = (point: THREE.Vector3) => {
    const key = createVectorKey(point);
    if (jointKeys.has(key)) return;
    jointKeys.add(key);
    joints.push(point.clone());
  };

  const addStrut = (start: THREE.Vector3, end: THREE.Vector3) => {
    if (start.distanceTo(end) < 0.01) return;
    const key = createStrutKey(start, end);
    if (strutKeys.has(key)) return;
    strutKeys.add(key);
    struts.push({ start: start.clone(), end: end.clone() });
  };

  type GridPoint = {
    top: THREE.Vector3;
    mid: THREE.Vector3;
    bottom: THREE.Vector3;
    valid: boolean;
  };

  const grid: GridPoint[][] = [];
  for (let r = 0; r <= rows; r++) {
    const row: GridPoint[] = [];
    for (let c = 0; c <= cols; c++) {
      const x = bounds.minX + c * spec.cellSizeCm;
      const z = bounds.minY + r * spec.cellSizeCm;

      if (!pointInPolygon(x, z, outerContour)) {
        row.push({
          top: new THREE.Vector3(0, 0, 0),
          mid: new THREE.Vector3(0, 0, 0),
          bottom: new THREE.Vector3(0, 0, 0),
          valid: false,
        });
        continue;
      }

      const height = getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation);
      const inset = Math.min(spec.jointRadiusCm, height / 2);
      const bottomY = inset;
      const topY = Math.max(bottomY, height - inset);
      const midY = (topY + bottomY) / 2;

      row.push({
        top: new THREE.Vector3(x, topY, z),
        mid: new THREE.Vector3(x, midY, z),
        bottom: new THREE.Vector3(x, bottomY, z),
        valid: true,
      });
    }
    grid.push(row);
  }

  const topCandidates: THREE.Vector3[] = [];
  const midCandidates: THREE.Vector3[] = [];
  const bottomCandidates: THREE.Vector3[] = [];

  for (let r = 0; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const point = grid[r][c];
      if (!point.valid) continue;
      addJoint(point.top);
      addJoint(point.bottom);
      topCandidates.push(point.top);
      midCandidates.push(point.mid);
      bottomCandidates.push(point.bottom);

      if (c < cols && grid[r][c + 1].valid) {
        addStrut(point.top, grid[r][c + 1].top);
        addStrut(point.bottom, grid[r][c + 1].bottom);
      }
      if (r < rows && grid[r + 1][c].valid) {
        addStrut(point.top, grid[r + 1][c].top);
        addStrut(point.bottom, grid[r + 1][c].bottom);
      }
      addStrut(point.top, point.bottom);
    }
  }

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const corners = [
        grid[r][c],
        grid[r][c + 1],
        grid[r + 1][c],
        grid[r + 1][c + 1],
      ];
      if (!corners.every(corner => corner.valid)) continue;

      const mid = new THREE.Vector3(
        (corners[0].top.x + corners[3].top.x) / 2,
        (corners[0].mid.y + corners[3].mid.y) / 2,
        (corners[0].top.z + corners[3].top.z) / 2,
      );
      addJoint(mid);
      midCandidates.push(mid);

      for (const corner of corners) {
        addStrut(mid, corner.top);
        addStrut(mid, corner.bottom);
      }
    }
  }

  const boundaryAnchors = sampleContourAnchors(outerContour, spec.boundaryAnchorSpacingCm);
  const sameLayerMaxDistance = spec.cellSizeCm * 1.45;
  const midLayerMaxDistance = spec.cellSizeCm * 1.75;

  const topBoundaryNodes = boundaryAnchors.map(([x, z]) => {
    const height = getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation);
    const inset = Math.min(spec.jointRadiusCm, height / 2);
    return new THREE.Vector3(x, Math.max(inset, height - inset), z);
  });
  const bottomBoundaryNodes = boundaryAnchors.map(([x, z]) => {
    const height = getInsoleHeight(x, z, footLength, archCorrection, baseThickness, foot, heelThickness, compensation);
    const inset = Math.min(spec.jointRadiusCm, height / 2);
    return new THREE.Vector3(x, inset, z);
  });

  topBoundaryNodes.forEach(addJoint);
  bottomBoundaryNodes.forEach(addJoint);

  for (let i = 0; i < boundaryAnchors.length; i++) {
    const nextIndex = (i + 1) % boundaryAnchors.length;
    const topNode = topBoundaryNodes[i];
    const nextTopNode = topBoundaryNodes[nextIndex];
    const bottomNode = bottomBoundaryNodes[i];
    const nextBottomNode = bottomBoundaryNodes[nextIndex];

    addStrut(topNode, nextTopNode);
    addStrut(bottomNode, nextBottomNode);
    addStrut(topNode, bottomNode);

    const nearestTop = findNearestPoints(topNode, topCandidates, sameLayerMaxDistance, 2);
    nearestTop.forEach(candidate => addStrut(topNode, candidate));

    const nearestBottom = findNearestPoints(bottomNode, bottomCandidates, sameLayerMaxDistance, 2);
    nearestBottom.forEach(candidate => addStrut(bottomNode, candidate));

    const boundaryMid = new THREE.Vector3(
      topNode.x,
      (topNode.y + bottomNode.y) / 2,
      topNode.z,
    );
    const nearestMid = findNearestPoints(boundaryMid, midCandidates, midLayerMaxDistance, 1);
    nearestMid.forEach(candidate => {
      addStrut(topNode, candidate);
      addStrut(bottomNode, candidate);
    });
  }

  return { struts, joints };
}
