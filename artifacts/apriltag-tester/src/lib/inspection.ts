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

export type PhysicalDimensions = {
  physicalWidthMm: number;
  physicalHeightMm: number;
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
export const DEFAULT_PHYSICAL_DIMENSIONS: PhysicalDimensions = {
  physicalWidthMm: 650,
  physicalHeightMm: 860,
};

// NIEUW: de genormaliseerde afbeelding is exact 1 px = 1 mm (zie
// normalizeImage hieronder, die de ImageData-breedte/hoogte rechtstreeks
// van physicalWidthMm/physicalHeightMm afleidt). Dat betekent dat we de
// inspectiezones rechtstreeks vanuit de échte onderdeel-afmetingen kunnen
// opbouwen, in plaats van percentages te gokken.
//
// Aangeleverde afmetingen (met tolerantie voor handmatige plaatsing en
// webcam-onnauwkeurigheid — geen precisiemeting):
//   - Lange, dunne profielen: 630 × 30 mm
//   - Dik middenprofiel (enkel Product 1): 370 × 60 mm
//   - Wielen: 60 × 60 mm
//   - Handvat: 110 × 40 mm
const PART_MM = {
  profileLong: { w: 630, h: 30 }, // het gewone 630 mm profiel, liggend (breed × dik)
  profileShortThick: { w: 60, h: 370 }, // het dikke 370×60 mm profiel, hier RECHTOP gemonteerd (dus 60 mm breed × 370 mm hoog)
  profileShortThin: { w: 370, h: 30 }, // een gewoon 370 mm profiel (Product 2), liggend
  wheel: { w: 60, h: 60 },
  handle: { w: 110, h: 40 },
};

// Tolerantie: hoeveel marge (in mm) elke zone extra krijgt rond het
// onderdeel, om kleine plaatsings- en meetonzekerheid op te vangen.
// Voor 'empty'-zones (waar net NIETS mag staan) passen we geen marge toe,
// om te vermijden dat een naburig onderdeel per ongeluk meegeteld wordt.
const TOLERANCE_MM = 15;

type ZoneDraft = {
  label: string;
  expect: 'present' | 'empty';
  threshold: number;
  /** Positie + afmeting in mm, gemeten vanaf de linkerbovenhoek van het
   *  fysieke referentiekader (physicalWidthMm × physicalHeightMm). */
  xMm: number;
  yMm: number;
  wMm: number;
  hMm: number;
  /** Standaard TOLERANCE_MM; zet op 0 voor 'empty'-zones. */
  toleranceMm?: number;
};

function zoneFromMm(draft: ZoneDraft, board: PhysicalDimensions = DEFAULT_PHYSICAL_DIMENSIONS): InspectionZone {
  const tolerance = draft.toleranceMm ?? TOLERANCE_MM;
  const xMm = draft.xMm - tolerance;
  const yMm = draft.yMm - tolerance;
  const wMm = draft.wMm + tolerance * 2;
  const hMm = draft.hMm + tolerance * 2;
  return {
    label: draft.label,
    expect: draft.expect,
    threshold: draft.threshold,
    x: Math.max(0, xMm / board.physicalWidthMm),
    y: Math.max(0, yMm / board.physicalHeightMm),
    w: Math.min(1, wMm / board.physicalWidthMm),
    h: Math.min(1, hMm / board.physicalHeightMm),
  };
}

// ------------------------------------------------------------------
// PRODUCT 1 — H-vormige opbouw met handvat (zie referentieschema):
// een handvat bovenaan, twee 630 mm profielen (boven en onder) met
// telkens 2 wielen aan de uiteinden, en het dikke 370×60 mm profiel
// rechtop gemonteerd in het midden tussen beide 630 mm profielen.
// ------------------------------------------------------------------
const board = DEFAULT_PHYSICAL_DIMENSIONS;
const assemblyWidth1 = PART_MM.profileLong.w; // 630 mm
const marginX1 = (board.physicalWidthMm - assemblyWidth1) / 2;

const handleY = 20;
const topProfileY = handleY + PART_MM.handle.h + 15; // handvat + kleine tussenruimte
const middleProfileY = topProfileY + PART_MM.profileLong.h; // net onder het bovenste profiel
const bottomProfileY = middleProfileY + PART_MM.profileShortThick.h; // net onder het middenprofiel

const PRODUCT1_ZONE_DRAFTS: ZoneDraft[] = [
  {
    label: 'handle', expect: 'present', threshold: 0.08,
    xMm: (board.physicalWidthMm - PART_MM.handle.w) / 2, yMm: handleY,
    wMm: PART_MM.handle.w, hMm: PART_MM.handle.h,
  },
  {
    label: 'profileTop630', expect: 'present', threshold: 0.08,
    xMm: marginX1, yMm: topProfileY,
    wMm: PART_MM.profileLong.w, hMm: PART_MM.profileLong.h,
  },
  {
    label: 'profileMiddle370', expect: 'present', threshold: 0.08,
    xMm: (board.physicalWidthMm - PART_MM.profileShortThick.w) / 2, yMm: middleProfileY,
    wMm: PART_MM.profileShortThick.w, hMm: PART_MM.profileShortThick.h,
  },
  {
    label: 'profileBottom630', expect: 'present', threshold: 0.08,
    xMm: marginX1, yMm: bottomProfileY,
    wMm: PART_MM.profileLong.w, hMm: PART_MM.profileLong.h,
  },
  {
    label: 'wheelTopLeft', expect: 'present', threshold: 0.08,
    xMm: marginX1, yMm: topProfileY + PART_MM.profileLong.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelTopRight', expect: 'present', threshold: 0.08,
    xMm: marginX1 + assemblyWidth1 - PART_MM.wheel.w, yMm: topProfileY + PART_MM.profileLong.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelBottomLeft', expect: 'present', threshold: 0.08,
    xMm: marginX1, yMm: bottomProfileY + PART_MM.profileLong.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelBottomRight', expect: 'present', threshold: 0.08,
    xMm: marginX1 + assemblyWidth1 - PART_MM.wheel.w, yMm: bottomProfileY + PART_MM.profileLong.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
];

// ------------------------------------------------------------------
// PRODUCT 2 — GEEN referentieschema aangeleverd; onderstaande opbouw is
// een consistente afleiding uit de eerder beschreven structuur (1×630 mm
// profiel + 2×370 mm gewone profielen + 4 wielen, geen handvat) en
// spiegelt Product 1's opbouw. Controleer dit zeker met een echte foto
// van Product 2 en stel bij via het kalibratiescherm indien nodig — dit
// is een inschatting, geen opgemeten schema zoals bij Product 1.
// ------------------------------------------------------------------
const assemblyWidth2 = PART_MM.profileShortThin.w; // 370 mm
const marginX2 = (board.physicalWidthMm - assemblyWidth2) / 2;

const topProfileY2 = 40;
const middleProfileY2 = topProfileY2 + PART_MM.profileShortThin.h;
const bottomProfileY2 = middleProfileY2 + PART_MM.profileLong.w; // het 630 mm profiel rechtop = zijn lengte (630) telt als hoogte

const PRODUCT2_ZONE_DRAFTS: ZoneDraft[] = [
  {
    label: 'handleArea', expect: 'empty', threshold: 0.05, toleranceMm: 0,
    xMm: (board.physicalWidthMm - PART_MM.handle.w) / 2, yMm: 0,
    wMm: PART_MM.handle.w, hMm: topProfileY2 - 5,
  },
  {
    label: 'profileTop370', expect: 'present', threshold: 0.08,
    xMm: marginX2, yMm: topProfileY2,
    wMm: PART_MM.profileShortThin.w, hMm: PART_MM.profileShortThin.h,
  },
  {
    label: 'profileMiddle630', expect: 'present', threshold: 0.08,
    xMm: (board.physicalWidthMm - PART_MM.profileLong.h) / 2, yMm: middleProfileY2,
    wMm: PART_MM.profileLong.h, hMm: PART_MM.profileLong.w,
  },
  {
    label: 'profileBottom370', expect: 'present', threshold: 0.08,
    xMm: marginX2, yMm: bottomProfileY2,
    wMm: PART_MM.profileShortThin.w, hMm: PART_MM.profileShortThin.h,
  },
  {
    label: 'wheelTopLeft', expect: 'present', threshold: 0.08,
    xMm: marginX2, yMm: topProfileY2 + PART_MM.profileShortThin.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelTopRight', expect: 'present', threshold: 0.08,
    xMm: marginX2 + assemblyWidth2 - PART_MM.wheel.w, yMm: topProfileY2 + PART_MM.profileShortThin.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelBottomLeft', expect: 'present', threshold: 0.08,
    xMm: marginX2, yMm: bottomProfileY2 + PART_MM.profileShortThin.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
  {
    label: 'wheelBottomRight', expect: 'present', threshold: 0.08,
    xMm: marginX2 + assemblyWidth2 - PART_MM.wheel.w, yMm: bottomProfileY2 + PART_MM.profileShortThin.h / 2 - PART_MM.wheel.h / 2,
    wMm: PART_MM.wheel.w, hMm: PART_MM.wheel.h,
  },
];

export const DEFAULT_PRODUCT_CONFIGS: Record<ProductId, ProductConfig> = {
  product1: {
    id: 'product1',
    name: 'Product 1',
    description: '2 × profiel 630×30 mm · 1 × profiel 370×60 mm (midden) · 4 wielen · handvat aanwezig',
    zones: PRODUCT1_ZONE_DRAFTS.map((draft) => zoneFromMm(draft)),
  },
  product2: {
    id: 'product2',
    name: 'Product 2',
    description: '1 × profiel 630×30 mm (midden) · 2 × profiel 370×30 mm · 4 wielen · geen handvat',
    zones: PRODUCT2_ZONE_DRAFTS.map((draft) => zoneFromMm(draft)),
  },
};

function cloneDefaults(): Record<ProductId, ProductConfig> {
  return JSON.parse(JSON.stringify(DEFAULT_PRODUCT_CONFIGS)) as Record<ProductId, ProductConfig>;
}

export function loadProductConfigs(): Record<ProductId, ProductConfig> {
  const defaults = cloneDefaults();
  if (typeof window === 'undefined') return defaults;
  try {
    const saved = JSON.parse(window.localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? 'null') as (Partial<Record<ProductId, ProductConfig>> & {
      products?: Partial<Record<ProductId, ProductConfig>>;
    }) | null;
    if (!saved) return defaults;
    const savedProducts = saved.products ?? saved;
    (Object.keys(defaults) as ProductId[]).forEach((productId) => {
      const savedZones = savedProducts[productId]?.zones;
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

export function loadPhysicalDimensions(): PhysicalDimensions {
  if (typeof window === 'undefined') return { ...DEFAULT_PHYSICAL_DIMENSIONS };
  try {
    const saved = JSON.parse(window.localStorage.getItem(CALIBRATION_STORAGE_KEY) ?? 'null') as
      | { physicalDimensions?: Partial<PhysicalDimensions> }
      | null;
    const width = saved?.physicalDimensions?.physicalWidthMm;
    const height = saved?.physicalDimensions?.physicalHeightMm;
    return {
      physicalWidthMm: typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : DEFAULT_PHYSICAL_DIMENSIONS.physicalWidthMm,
      physicalHeightMm: typeof height === 'number' && Number.isFinite(height) && height > 0 ? height : DEFAULT_PHYSICAL_DIMENSIONS.physicalHeightMm,
    };
  } catch {
    return { ...DEFAULT_PHYSICAL_DIMENSIONS };
  }
}

export function resetProductConfigs(): Record<ProductId, ProductConfig> {
  return cloneDefaults();
}

export function resetPhysicalDimensions(): PhysicalDimensions {
  return { ...DEFAULT_PHYSICAL_DIMENSIONS };
}

export function saveProductConfigs(configs: Record<ProductId, ProductConfig>, physicalDimensions: PhysicalDimensions) {
  if (typeof window !== 'undefined') {
    window.localStorage.setItem(CALIBRATION_STORAGE_KEY, JSON.stringify({ products: configs, physicalDimensions }));
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

export function detectionCenter(detection: Detection): Corner {
  return detection.center ?? detection.corners.reduce(
    (center, corner) => ({ x: center.x + corner.x / detection.corners.length, y: center.y + corner.y / detection.corners.length }),
    { x: 0, y: 0 },
  );
}

export function distanceBetweenDetections(detections: Detection[], firstId: number, secondId: number): number | null {
  const first = detections.find((detection) => detection.id === firstId);
  const second = detections.find((detection) => detection.id === secondId);
  if (!first || !second) return null;
  const firstCenter = detectionCenter(first);
  const secondCenter = detectionCenter(second);
  return Math.hypot(secondCenter.x - firstCenter.x, secondCenter.y - firstCenter.y);
}

export function normalizeImage(
  source: ImageData,
  detections: Detection[],
  dimensions: PhysicalDimensions = DEFAULT_PHYSICAL_DIMENSIONS,
): ImageData | null {
  const byId = new Map(detections.map((detection) => [detection.id, detection]));
  const sourcePoints = [0, 1, 3, 2].map((id) => byId.get(id)).filter((detection): detection is Detection => Boolean(detection)).map(detectionCenter);
  if (sourcePoints.length !== 4) return null;

  const width = Math.max(1, Math.round(dimensions.physicalWidthMm));
  const height = Math.max(1, Math.round(dimensions.physicalHeightMm));
  const destinationPoints = [
    { x: 0, y: 0 },
    { x: width - 1, y: 0 },
    { x: width - 1, y: height - 1 },
    { x: 0, y: height - 1 },
  ];
  const mapping = homographyFromFourPoints(destinationPoints, sourcePoints);
  if (!mapping) return null;

  const output = new ImageData(width, height);
  const outputPixels = output.data;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denominator = mapping[6] * x + mapping[7] * y + mapping[8];
      const sourceX = (mapping[0] * x + mapping[1] * y + mapping[2]) / denominator;
      const sourceY = (mapping[3] * x + mapping[4] * y + mapping[5]) / denominator;
      const outputIndex = (y * width + x) * 4;
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
  if (zone.label === 'profileTop630' || zone.label === 'profileBottom630') return 'Profiel 630×30 mm niet gedetecteerd';
  if (zone.label === 'profileMiddle370') return 'Middenprofiel 370×60 mm niet gedetecteerd';
  if (zone.label === 'profileMiddle630') return 'Middenprofiel 630×30 mm niet gedetecteerd';
  if (zone.label === 'profileTop370' || zone.label === 'profileBottom370') return 'Profiel 370×30 mm niet gedetecteerd';
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
