export type Corner = { x: number; y: number };

export type Detection = {
  id: number;
  corners: Corner[];
  center?: Corner;
};

export type InspectionZone = {
  x: number;
  y: number;
  w: number;
  h: number;
  label: string;
  threshold: number;
  expect: 'present' | 'empty';
};

export type ProductId = 'product1' | 'product2';

export type ProductConfig = {
  id: ProductId;
  name: string;
  description: string;
  zones: InspectionZone[];
};

export type ZoneResult = InspectionZone & {
  edgeDensity: number;
  averageBrightness: number;
  contrast: number;
  pass: boolean;
};

export type InspectionResult = {
  product: ProductId;
  context: 'final-qc';
  status: 'ok' | 'error';
  detectedTags: number[];
  checks: {
    wheels: boolean;
    profiles: boolean;
    handle: boolean;
  };
  errors: string[];
  timestamp: number;
  zones: ZoneResult[];
};

export const CALIBRATION_STORAGE_KEY = 'apriltag-tester-calibration-v1';
export const NORMALIZED_SIZE = 800;

export const DEFAULT_PRODUCT_CONFIGS: Record<ProductId, ProductConfig> = {
  product1: {
    id: 'product1',
    name: 'Product 1',
    description: 'H-shaped aluminium profile · 4 wheels · handle present',
    zones: [
      { x: 0.05, y: 0.05, w: 0.18, h: 0.18, label: 'wheelTopLeft', threshold: 0.08, expect: 'present' },
      { x: 0.77, y: 0.05, w: 0.18, h: 0.18, label: 'wheelTopRight', threshold: 0.08, expect: 'present' },
      { x: 0.05, y: 0.77, w: 0.18, h: 0.18, label: 'wheelBottomLeft', threshold: 0.08, expect: 'present' },
      { x: 0.77, y: 0.77, w: 0.18, h: 0.18, label: 'wheelBottomRight', threshold: 0.08, expect: 'present' },
      { x: 0.38, y: 0.04, w: 0.24, h: 0.18, label: 'handle', threshold: 0.08, expect: 'present' },
      { x: 0.28, y: 0.30, w: 0.44, h: 0.40, label: 'profileCenter', threshold: 0.08, expect: 'present' },
    ],
  },
  product2: {
    id: 'product2',
    name: 'Product 2',
    description: '1 × 630 mm profile · 2 × 370 mm profiles · 4 wheels · no handle',
    zones: [
      { x: 0.05, y: 0.05, w: 0.18, h: 0.18, label: 'wheelTopLeft', threshold: 0.08, expect: 'present' },
      { x: 0.77, y: 0.05, w: 0.18, h: 0.18, label: 'wheelTopRight', threshold: 0.08, expect: 'present' },
      { x: 0.05, y: 0.77, w: 0.18, h: 0.18, label: 'wheelBottomLeft', threshold: 0.08, expect: 'present' },
      { x: 0.77, y: 0.77, w: 0.18, h: 0.18, label: 'wheelBottomRight', threshold: 0.08, expect: 'present' },
      { x: 0.29, y: 0.20, w: 0.42, h: 0.16, label: 'profile630', threshold: 0.08, expect: 'present' },
      { x: 0.29, y: 0.42, w: 0.42, h: 0.12, label: 'profile370A', threshold: 0.08, expect: 'present' },
      { x: 0.29, y: 0.60, w: 0.42, h: 0.12, label: 'profile370B', threshold: 0.08, expect: 'present' },
      { x: 0.38, y: 0.04, w: 0.24, h: 0.13, label: 'handleArea', threshold: 0.05, expect: 'empty' },
    ],
  },
};

function cloneDefaults(): Record<ProductId, ProductConfig> {
  return JSON.parse(JSON.stringify(DEFAULT_PRODUCT_CONFIGS)) as Record<ProductId, ProductConfig>;
}

export function loadProductConfigs(): Record<ProductId, ProductConfig> {
  const defaults = cloneDefaults();
  if (typeof window === 'undefined') return defaults;
  try {
    const saved = JSON.parse(window.localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? 'null') as Partial<Record<ProductId, ProductConfig>> | null;
    if (!saved) return defaults;
    (Object.keys(defaults) as ProductId[]).forEach((productId) => {
      const savedZones = saved[productId]?.zones;
      if (!Array.isArray(savedZones)) return;
      defaults[productId].zones = defaults[productId].zones.map((zone, index) => {
        const candidate = savedZones[index];
        if (!candidate) return zone;
        const numeric = ['x', 'y', 'w', 'h', 'threshold'] as const;
        const next = { ...zone };
        numeric.forEach((key) => {
          if (typeof candidate[key] === 'number' && Number.isFinite(candidate[key])) {
            next[key] = Math.min(1, Math.max(0, candidate[key]));
          }
        });
        return next;
      });
    });
    return defaults;
  } catch {
    return defaults;
  }
}

export function resetProductConfigs(): Record<ProductId, ProductConfig> {
  return cloneDefaults();
}

export function saveProductConfigs(configs: Record<ProductId, ProductConfig>) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify(configs));
  }
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
      for (let value = column; value <= size; value += 1) augmented[row][value] -= factor * augmented[column][value];
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

export function normalizeImage(source: ImageData, detections: Detection[], size = NORMALIZED_SIZE): ImageData | null {
  const byId = new Map(detections.map((detection) => [detection.id, detection]));
  const centerOf = (detection: Detection): Corner => detection.center ?? detection.corners.reduce(
    (center, corner) => ({ x: center.x + corner.x / detection.corners.length, y: center.y + corner.y / detection.corners.length }),
    { x: 0, y: 0 },
  );
  const sourcePoints = [0, 1, 3, 2].map((id) => byId.get(id)).filter((detection): detection is Detection => Boolean(detection)).map(centerOf);
  if (sourcePoints.length !== 4) return null;

  const destinationPoints = [
    { x: 0, y: 0 },
    { x: size - 1, y: 0 },
    { x: size - 1, y: size - 1 },
    { x: 0, y: size - 1 },
  ];
  const mapping = homographyFromFourPoints(destinationPoints, sourcePoints);
  if (!mapping) return null;

  const output = new ImageData(size, size);
  const outputPixels = output.data;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const denominator = mapping[6] * x + mapping[7] * y + mapping[8];
      const sourceX = (mapping[0] * x + mapping[1] * y + mapping[2]) / denominator;
      const sourceY = (mapping[3] * x + mapping[4] * y + mapping[5]) / denominator;
      const outputIndex = (y * size + x) * 4;
      if (sourceX < 0 || sourceY < 0 || sourceX >= source.width || sourceY >= source.height) {
        outputPixels[outputIndex] = 235;
        outputPixels[outputIndex + 1] = 235;
        outputPixels[outputIndex + 2] = 228;
        outputPixels[outputIndex + 3] = 255;
        continue;
      }
      const sourceIndex = (Math.floor(sourceY) * source.width + Math.floor(sourceX)) * 4;
      outputPixels[outputIndex] = source.data[sourceIndex];
      outputPixels[outputIndex + 1] = source.data[sourceIndex + 1];
      outputPixels[outputIndex + 2] = source.data[sourceIndex + 2];
      outputPixels[outputIndex + 3] = 255;
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

export function analyzeZone(imageData: ImageData, zone: InspectionZone): ZoneResult {
  const x0 = Math.max(0, Math.floor(zone.x * imageData.width));
  const y0 = Math.max(0, Math.floor(zone.y * imageData.height));
  const x1 = Math.min(imageData.width - 1, Math.max(x0 + 1, Math.floor((zone.x + zone.w) * imageData.width)));
  const y1 = Math.min(imageData.height - 1, Math.max(y0 + 1, Math.floor((zone.y + zone.h) * imageData.height)));
  let edgePixels = 0;
  let samples = 0;
  let brightnessTotal = 0;
  let brightnessSquared = 0;
  const luminance = (x: number, y: number) => {
    const index = (y * imageData.width + x) * 4;
    return imageData.data[index] * 0.299 + imageData.data[index + 1] * 0.587 + imageData.data[index + 2] * 0.114;
  };
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = luminance(x, y);
      brightnessTotal += value;
      brightnessSquared += value * value;
      if (x < x1 - 1 && y < y1 - 1) {
        const gradient = Math.abs(value - luminance(x + 1, y)) + Math.abs(value - luminance(x, y + 1));
        if (gradient > 42) edgePixels += 1;
        samples += 1;
      }
    }
  }
  const pixelCount = Math.max(1, (x1 - x0) * (y1 - y0));
  const averageBrightness = brightnessTotal / pixelCount;
  const contrast = Math.sqrt(Math.max(0, brightnessSquared / pixelCount - averageBrightness * averageBrightness));
  const edgeDensity = edgePixels / Math.max(1, samples);
  const pass = zone.expect === 'empty' ? edgeDensity < zone.threshold : edgeDensity >= zone.threshold;
  return { ...zone, edgeDensity, averageBrightness, contrast, pass };
}

function errorForZone(zone: ZoneResult): string {
  if (zone.pass) return '';
  if (zone.label === 'handleArea') return 'Onverwacht handvat gedetecteerd';
  if (zone.label === 'handle') return 'Handvat ontbreekt';
  if (zone.label === 'profile630') return 'Profiel 630 mm niet gedetecteerd';
  if (zone.label === 'profile370A' || zone.label === 'profile370B') return `${zone.label} profiel niet gedetecteerd`;
  if (zone.label.startsWith('wheel')) {
    const names: Record<string, string> = {
      wheelTopLeft: 'Wiel linksboven ontbreekt',
      wheelTopRight: 'Wiel rechtsboven ontbreekt',
      wheelBottomLeft: 'Wiel linksonder ontbreekt',
      wheelBottomRight: 'Wiel rechtsonder ontbreekt',
    };
    return names[zone.label] ?? `${zone.label} ontbreekt`;
  }
  return `${zone.label} niet gedetecteerd`;
}

export function inspectNormalizedImage(
  imageData: ImageData,
  config: ProductConfig,
  detectedTags: number[],
): InspectionResult {
  const zones = config.zones.map((zone) => analyzeZone(imageData, zone));
  const wheels = zones.filter((zone) => zone.label.startsWith('wheel')).every((zone) => zone.pass);
  const profiles = zones.filter((zone) => zone.label.includes('profile')).every((zone) => zone.pass);
  const handleZone = zones.find((zone) => zone.label === 'handle' || zone.label === 'handleArea');
  const handle = handleZone?.pass ?? false;
  const errors = zones.map(errorForZone).filter(Boolean);
  return {
    product: config.id,
    context: 'final-qc',
    status: wheels && profiles && handle ? 'ok' : 'error',
    detectedTags,
    checks: { wheels, profiles, handle },
    errors,
    timestamp: Date.now(),
    zones,
  };
}