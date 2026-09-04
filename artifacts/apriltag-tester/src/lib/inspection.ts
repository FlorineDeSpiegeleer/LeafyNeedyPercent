export type Corner = { x: number; y: number };

export type Detection = {
  id: number;
  corners: Corner[];
  center?: Corner;
};

export type ZoneKind = 'present' | 'empty';

export type InspectionZone = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: ZoneKind;
  minEdgeDensity?: number;
  maxEdgeDensity?: number;
};

export type ZoneResult = InspectionZone & {
  edgeDensity: number;
  contrast: number;
  pass: boolean;
};

export type InspectionResult = {
  status: 'ok' | 'error';
  context: 'final-qc';
  product: 'product1';
  detectedTags: number[];
  checks: {
    wheels: boolean;
    topProfile: boolean;
    bottomProfile: boolean;
    centerProfile: boolean;
    handle: boolean;
  };
  errors: string[];
  zones: ZoneResult[];
  timestamp: number;
};

/**
 * Referentievlak tussen de vier AprilTag-CENTRA.
 * Fysieke verhouding: 810 mm breed × 650 mm hoog.
 * We gebruiken dezelfde verhouding in pixels zodat het genormaliseerde beeld
 * niet meer vierkant wordt vervormd.
 */
export const NORMALIZED_WIDTH = 810;
export const NORMALIZED_HEIGHT = 650;

/**
 * Product 1 referentie-layout gebaseerd op de door jou aangeleverde
 * bovenaanzicht-tekening: boven- en onderprofiel, centrale verticale balk,
 * vier wielen en het handvat bovenaan.
 *
 * De zones zijn bewust relatief (0..1), zodat ze exact hetzelfde blijven
 * werken wanneer het referentievlak later op een andere resolutie wordt
 * weergegeven.
 */
export const PRODUCT1_ZONES: InspectionZone[] = [
  // Horizontale hoofdprofielen
  { id: 'topProfile', label: 'Bovenprofiel', x: 0.13, y: 0.12, w: 0.74, h: 0.15, kind: 'present', minEdgeDensity: 0.020 },
  { id: 'bottomProfile', label: 'Onderprofiel', x: 0.14, y: 0.76, w: 0.73, h: 0.15, kind: 'present', minEdgeDensity: 0.020 },

  // Centrale verticale verbinding
  { id: 'centerProfile', label: 'Middenprofiel', x: 0.42, y: 0.25, w: 0.17, h: 0.53, kind: 'present', minEdgeDensity: 0.018 },

  // Wielen links/rechts boven/onder
  { id: 'wheelTopLeft', label: 'Wiel linksboven', x: 0.10, y: 0.13, w: 0.20, h: 0.24, kind: 'present', minEdgeDensity: 0.022 },
  { id: 'wheelTopRight', label: 'Wiel rechtsboven', x: 0.71, y: 0.13, w: 0.20, h: 0.24, kind: 'present', minEdgeDensity: 0.022 },
  { id: 'wheelBottomLeft', label: 'Wiel linksonder', x: 0.11, y: 0.68, w: 0.21, h: 0.23, kind: 'present', minEdgeDensity: 0.022 },
  { id: 'wheelBottomRight', label: 'Wiel rechtsonder', x: 0.72, y: 0.68, w: 0.20, h: 0.23, kind: 'present', minEdgeDensity: 0.022 },

  // Handvat bovenaan in het midden
  { id: 'handle', label: 'Handvat', x: 0.38, y: 0.02, w: 0.25, h: 0.14, kind: 'present', minEdgeDensity: 0.020 },

  // Lege zones helpen voorkomen dat een willekeurig druk beeld toch slaagt.
  { id: 'emptyLeftCenter', label: 'Vrije zone links', x: 0.17, y: 0.40, w: 0.20, h: 0.22, kind: 'empty', maxEdgeDensity: 0.065 },
  { id: 'emptyRightCenter', label: 'Vrije zone rechts', x: 0.64, y: 0.40, w: 0.20, h: 0.22, kind: 'empty', maxEdgeDensity: 0.065 },
];

function centerOf(detection: Detection): Corner {
  if (detection.center) return detection.center;
  return detection.corners.reduce(
    (acc, corner) => ({
      x: acc.x + corner.x / detection.corners.length,
      y: acc.y + corner.y / detection.corners.length,
    }),
    { x: 0, y: 0 },
  );
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] | null {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;

    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let value = column; value <= size; value += 1) augmented[column][value] /= divisor;

    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let value = column; value <= size; value += 1) {
        augmented[row][value] -= factor * augmented[column][value];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

function homographyFromFourPoints(from: Corner[], to: Corner[]): number[] | null {
  const matrix: number[][] = [];
  const values: number[] = [];

  from.forEach((point, index) => {
    const target = to[index];
    matrix.push([point.x, point.y, 1, 0, 0, 0, -target.x * point.x, -target.x * point.y]);
    values.push(target.x);
    matrix.push([0, 0, 0, point.x, point.y, 1, -target.y * point.x, -target.y * point.y]);
    values.push(target.y);
  });

  const solution = solveLinearSystem(matrix, values);
  return solution ? [...solution, 1] : null;
}

/**
 * Maakt een perspectiefgecorrigeerd bovenaanzicht op basis van de CENTRA
 * van tag 0..3:
 *   0 = linksboven
 *   1 = rechtsboven
 *   2 = linksonder
 *   3 = rechtsonder
 */
export function normalizeImage(
  source: ImageData,
  detections: Detection[],
  width = NORMALIZED_WIDTH,
  height = NORMALIZED_HEIGHT,
): ImageData | null {
  const byId = new Map(detections.map((detection) => [detection.id, detection]));
  const sourcePoints = [0, 1, 3, 2]
    .map((id) => byId.get(id))
    .filter((detection): detection is Detection => Boolean(detection))
    .map(centerOf);

  if (sourcePoints.length !== 4) return null;

  const destinationPoints = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];

  // We berekenen doel -> bron, zodat ieder doelpixel rechtstreeks uit de
  // oorspronkelijke camerafoto wordt gelezen.
  const mapping = homographyFromFourPoints(destinationPoints, sourcePoints);
  if (!mapping) return null;

  const output = new ImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denominator = mapping[6] * x + mapping[7] * y + mapping[8];
      const sx = (mapping[0] * x + mapping[1] * y + mapping[2]) / denominator;
      const sy = (mapping[3] * x + mapping[4] * y + mapping[5]) / denominator;
      const out = (y * width + x) * 4;

      if (sx < 0 || sy < 0 || sx >= source.width - 1 || sy >= source.height - 1) {
        output.data[out] = 245;
        output.data[out + 1] = 245;
        output.data[out + 2] = 245;
        output.data[out + 3] = 255;
        continue;
      }

      // Bilineaire interpolatie: duidelijker dan nearest-neighbour en dus
      // stabieler voor de latere randanalyse.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(source.width - 1, x0 + 1);
      const y1 = Math.min(source.height - 1, y0 + 1);
      const dx = sx - x0;
      const dy = sy - y0;

      for (let c = 0; c < 3; c += 1) {
        const p00 = source.data[(y0 * source.width + x0) * 4 + c];
        const p10 = source.data[(y0 * source.width + x1) * 4 + c];
        const p01 = source.data[(y1 * source.width + x0) * 4 + c];
        const p11 = source.data[(y1 * source.width + x1) * 4 + c];
        const top = p00 * (1 - dx) + p10 * dx;
        const bottom = p01 * (1 - dx) + p11 * dx;
        output.data[out + c] = Math.round(top * (1 - dy) + bottom * dy);
      }
      output.data[out + 3] = 255;
    }
  }

  return output;
}

export function imageDataToUrl(imageData: ImageData): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')?.putImageData(imageData, 0, 0);
  return canvas.toDataURL('image/jpeg', 0.94);
}

function luminance(imageData: ImageData, x: number, y: number) {
  const i = (y * imageData.width + x) * 4;
  return imageData.data[i] * 0.299 + imageData.data[i + 1] * 0.587 + imageData.data[i + 2] * 0.114;
}

export function analyzeZone(imageData: ImageData, zone: InspectionZone): ZoneResult {
  const x0 = Math.max(1, Math.floor(zone.x * imageData.width));
  const y0 = Math.max(1, Math.floor(zone.y * imageData.height));
  const x1 = Math.min(imageData.width - 2, Math.floor((zone.x + zone.w) * imageData.width));
  const y1 = Math.min(imageData.height - 2, Math.floor((zone.y + zone.h) * imageData.height));

  let edgePixels = 0;
  let samples = 0;
  let sum = 0;
  let sumSquared = 0;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const v = luminance(imageData, x, y);
      const gx = Math.abs(luminance(imageData, x + 1, y) - luminance(imageData, x - 1, y));
      const gy = Math.abs(luminance(imageData, x, y + 1) - luminance(imageData, x, y - 1));
      const gradient = gx + gy;

      if (gradient > 48) edgePixels += 1;
      samples += 1;
      sum += v;
      sumSquared += v * v;
    }
  }

  const count = Math.max(1, samples);
  const average = sum / count;
  const contrast = Math.sqrt(Math.max(0, sumSquared / count - average * average));
  const edgeDensity = edgePixels / count;

  const pass = zone.kind === 'present'
    ? edgeDensity >= (zone.minEdgeDensity ?? 0.02)
    : edgeDensity <= (zone.maxEdgeDensity ?? 0.06);

  return { ...zone, edgeDensity, contrast, pass };
}

function resultFor(zones: ZoneResult[], id: string) {
  return zones.find((z) => z.id === id)?.pass ?? false;
}

export function inspectProduct1(imageData: ImageData, detectedTags: number[]): InspectionResult {
  const zones = PRODUCT1_ZONES.map((zone) => analyzeZone(imageData, zone));

  const wheelIds = ['wheelTopLeft', 'wheelTopRight', 'wheelBottomLeft', 'wheelBottomRight'];
  const wheels = wheelIds.every((id) => resultFor(zones, id));
  const topProfile = resultFor(zones, 'topProfile');
  const bottomProfile = resultFor(zones, 'bottomProfile');
  const centerProfile = resultFor(zones, 'centerProfile');
  const handle = resultFor(zones, 'handle');
  const emptyZonesOk = resultFor(zones, 'emptyLeftCenter') && resultFor(zones, 'emptyRightCenter');

  const errors: string[] = [];
  if (!topProfile) errors.push('Bovenprofiel niet correct gedetecteerd');
  if (!bottomProfile) errors.push('Onderprofiel niet correct gedetecteerd');
  if (!centerProfile) errors.push('Middenprofiel niet correct gedetecteerd');
  if (!handle) errors.push('Handvat niet correct gedetecteerd');

  const wheelLabels: Record<string, string> = {
    wheelTopLeft: 'Wiel linksboven ontbreekt of staat niet op de verwachte plaats',
    wheelTopRight: 'Wiel rechtsboven ontbreekt of staat niet op de verwachte plaats',
    wheelBottomLeft: 'Wiel linksonder ontbreekt of staat niet op de verwachte plaats',
    wheelBottomRight: 'Wiel rechtsonder ontbreekt of staat niet op de verwachte plaats',
  };
  wheelIds.forEach((id) => {
    if (!resultFor(zones, id)) errors.push(wheelLabels[id]);
  });
  if (!emptyZonesOk) errors.push('Onverwachte structuur in een vrije referentiezone');

  const status = wheels && topProfile && bottomProfile && centerProfile && handle && emptyZonesOk
    ? 'ok'
    : 'error';

  return {
    status,
    context: 'final-qc',
    product: 'product1',
    detectedTags,
    checks: { wheels, topProfile, bottomProfile, centerProfile, handle },
    errors,
    zones,
    timestamp: Date.now(),
  };
}
