export type Corner = { x: number; y: number };

export type Detection = {
  id: number;
  corners: Corner[];
  center?: Corner;
};

export type ComparisonZone = {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;

  /**
   * Minimum edge similarity to the GOOD reference image.
   * 0.00 = completely different, 1.00 = identical edge geometry.
   */
  minSimilarity: number;
};

export type ZoneComparisonResult = ComparisonZone & {
  similarity: number;
  referenceEdgeDensity: number;
  currentEdgeDensity: number;
  densityAgreement: number;
  pass: boolean;
};

export type InspectionResult = {
  status: 'ok' | 'error';
  context: 'final-qc';
  product: 'product1';
  detectedTags: number[];
  overallSimilarity: number;
  checks: {
    wheels: boolean;
    topProfile: boolean;
    bottomProfile: boolean;
    centerProfile: boolean;
    handle: boolean;
  };
  scores: {
    wheels: number;
    topProfile: number;
    bottomProfile: number;
    centerProfile: number;
    handle: number;
  };
  errors: string[];
  zones: ZoneComparisonResult[];
  timestamp: number;
};

export const NORMALIZED_WIDTH = 810;
export const NORMALIZED_HEIGHT = 650;

export const REFERENCE_STORAGE_KEY = 'apriltag-product1-reference-v1';

/**
 * Controlezones in het 810 × 650 genormaliseerde beeld.
 *
 * BELANGRIJK:
 * Deze zones worden NIET meer gebruikt om alleen te vragen
 * "zitten hier genoeg randen?".
 *
 * De randen in de NIEUWE foto worden rechtstreeks vergeleken met
 * de randen in één correcte referentiefoto van jouw echte Product 1.
 *
 * Daardoor kan bv. een handvat in de profielzone niet zomaar een profiel
 * vervangen: de vorm en positie van de randen moeten overeenkomen met
 * de correcte referentie.
 */
export const PRODUCT1_COMPARISON_ZONES: ComparisonZone[] = [
  // Handvat — volledige verwachte handvatzone.
  { id: 'handle', label: 'Handvat', x: 0.36, y: 0.00, w: 0.29, h: 0.145, minSimilarity: 0.55 },

  // Hoofdprofielen.
  { id: 'topProfile', label: 'Bovenprofiel', x: 0.12, y: 0.115, w: 0.76, h: 0.17, minSimilarity: 0.62 },
  { id: 'bottomProfile', label: 'Onderprofiel', x: 0.13, y: 0.74, w: 0.75, h: 0.18, minSimilarity: 0.62 },
  { id: 'centerProfile', label: 'Middenprofiel', x: 0.39, y: 0.23, w: 0.22, h: 0.56, minSimilarity: 0.62 },

  // Wielen.
  { id: 'wheelTopLeft', label: 'Wiel linksboven', x: 0.075, y: 0.11, w: 0.23, h: 0.27, minSimilarity: 0.48 },
  { id: 'wheelTopRight', label: 'Wiel rechtsboven', x: 0.695, y: 0.11, w: 0.23, h: 0.27, minSimilarity: 0.48 },
  { id: 'wheelBottomLeft', label: 'Wiel linksonder', x: 0.085, y: 0.655, w: 0.24, h: 0.27, minSimilarity: 0.48 },
  { id: 'wheelBottomRight', label: 'Wiel rechtsonder', x: 0.70, y: 0.655, w: 0.23, h: 0.27, minSimilarity: 0.48 },
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
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }

    if (Math.abs(augmented[pivot][column]) < 1e-10) return null;

    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];

    const divisor = augmented[column][column];

    for (let value = column; value <= size; value += 1) {
      augmented[column][value] /= divisor;
    }

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

    matrix.push([
      point.x,
      point.y,
      1,
      0,
      0,
      0,
      -target.x * point.x,
      -target.x * point.y,
    ]);
    values.push(target.x);

    matrix.push([
      0,
      0,
      0,
      point.x,
      point.y,
      1,
      -target.y * point.x,
      -target.y * point.y,
    ]);
    values.push(target.y);
  });

  const solution = solveLinearSystem(matrix, values);
  return solution ? [...solution, 1] : null;
}

/**
 * Perspectiefcorrectie:
 * ID 0 = linksboven
 * ID 1 = rechtsboven
 * ID 2 = linksonder
 * ID 3 = rechtsonder
 *
 * De CENTRA van de tags vormen de fysieke referentierechthoek.
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

  // Doel -> bron mapping.
  const mapping = homographyFromFourPoints(destinationPoints, sourcePoints);
  if (!mapping) return null;

  const output = new ImageData(width, height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const denominator = mapping[6] * x + mapping[7] * y + mapping[8];

      const sx = (mapping[0] * x + mapping[1] * y + mapping[2]) / denominator;
      const sy = (mapping[3] * x + mapping[4] * y + mapping[5]) / denominator;

      const out = (y * width + x) * 4;

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < 0 ||
        sy < 0 ||
        sx >= source.width - 1 ||
        sy >= source.height - 1
      ) {
        output.data[out] = 245;
        output.data[out + 1] = 245;
        output.data[out + 2] = 245;
        output.data[out + 3] = 255;
        continue;
      }

      // Bilineaire interpolatie.
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

export function imageDataToUrl(imageData: ImageData, quality = 0.92): string {
  const canvas = document.createElement('canvas');
  canvas.width = imageData.width;
  canvas.height = imageData.height;
  canvas.getContext('2d')?.putImageData(imageData, 0, 0);

  return canvas.toDataURL('image/jpeg', quality);
}

export async function dataUrlToImageData(dataUrl: string): Promise<ImageData> {
  const image = new Image();

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Referentiebeeld kon niet worden geladen.'));
    image.src = dataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = NORMALIZED_WIDTH;
  canvas.height = NORMALIZED_HEIGHT;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas niet beschikbaar.');

  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  return context.getImageData(0, 0, canvas.width, canvas.height);
}

function luminance(imageData: ImageData, x: number, y: number): number {
  const i = (y * imageData.width + x) * 4;

  return (
    imageData.data[i] * 0.299 +
    imageData.data[i + 1] * 0.587 +
    imageData.data[i + 2] * 0.114
  );
}

/**
 * Kleine 3 × 3 blur vóór randdetectie.
 * Dit maakt de vergelijking minder gevoelig voor sensorruis en kleine
 * lichtverschillen.
 */
function createBlurredGrayscale(imageData: ImageData): Float32Array {
  const width = imageData.width;
  const height = imageData.height;

  const gray = new Float32Array(width * height);
  const blurred = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = luminance(imageData, x, y);
    }
  }

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          sum += gray[(y + oy) * width + (x + ox)];
        }
      }

      blurred[y * width + x] = sum / 9;
    }
  }

  return blurred;
}

/**
 * Binaire edge-map.
 *
 * We gebruiken Sobel-achtige horizontale + verticale verschillen.
 * Omdat enkel randen worden vergeleken, is de methode veel minder
 * gevoelig voor een iets lichtere/donkere camerafoto.
 */
function createEdgeMap(imageData: ImageData): Uint8Array {
  const width = imageData.width;
  const height = imageData.height;
  const gray = createBlurredGrayscale(imageData);
  const edges = new Uint8Array(width * height);

  // Iets lager dan de oude edge-density drempel, omdat de latere
  // referentievergelijking zelf streng genoeg is.
  const EDGE_THRESHOLD = 34;

  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const left = gray[y * width + (x - 1)];
      const right = gray[y * width + (x + 1)];
      const top = gray[(y - 1) * width + x];
      const bottom = gray[(y + 1) * width + x];

      const gx = Math.abs(right - left);
      const gy = Math.abs(bottom - top);

      edges[y * width + x] = gx + gy >= EDGE_THRESHOLD ? 1 : 0;
    }
  }

  return edges;
}

function hasEdgeNearby(
  edgeMap: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): boolean {
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const nx = x + ox;
      const ny = y + oy;

      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

      if (edgeMap[ny * width + nx]) return true;
    }
  }

  return false;
}

/**
 * Vergelijk één ROI uit de NIEUWE foto met exact dezelfde ROI uit
 * de correcte referentiefoto.
 *
 * De score combineert:
 * - hoeveel REFERENTIERANDEN ook in de nieuwe foto teruggevonden worden;
 * - hoeveel NIEUWE randen ook in de referentie bestaan;
 * - overeenkomst in totale hoeveelheid structuur.
 *
 * Door een tolerantie van 4 pixels mag een rand na de homografie heel
 * licht verschuiven zonder meteen NOK te worden.
 */
function compareZone(
  referenceEdges: Uint8Array,
  currentEdges: Uint8Array,
  width: number,
  height: number,
  zone: ComparisonZone,
): ZoneComparisonResult {
  const x0 = Math.max(2, Math.floor(zone.x * width));
  const y0 = Math.max(2, Math.floor(zone.y * height));
  const x1 = Math.min(width - 2, Math.floor((zone.x + zone.w) * width));
  const y1 = Math.min(height - 2, Math.floor((zone.y + zone.h) * height));

  let referenceCount = 0;
  let currentCount = 0;
  let referenceMatched = 0;
  let currentMatched = 0;

  const TOLERANCE_RADIUS = 4;

  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const index = y * width + x;

      if (referenceEdges[index]) {
        referenceCount += 1;

        if (
          hasEdgeNearby(
            currentEdges,
            width,
            height,
            x,
            y,
            TOLERANCE_RADIUS,
          )
        ) {
          referenceMatched += 1;
        }
      }

      if (currentEdges[index]) {
        currentCount += 1;

        if (
          hasEdgeNearby(
            referenceEdges,
            width,
            height,
            x,
            y,
            TOLERANCE_RADIUS,
          )
        ) {
          currentMatched += 1;
        }
      }
    }
  }

  const area = Math.max(1, (x1 - x0) * (y1 - y0));

  const referenceEdgeDensity = referenceCount / area;
  const currentEdgeDensity = currentCount / area;

  // Hoeveel van de verwachte randen zijn aanwezig?
  const recall =
    referenceCount > 0 ? referenceMatched / referenceCount : 1;

  // Hoeveel van de huidige randen horen ook echt bij de referentie?
  // Dit straft een fout onderdeel / extra structuur in dezelfde zone af.
  const precision =
    currentCount > 0 ? currentMatched / currentCount : referenceCount === 0 ? 1 : 0;

  const edgeGeometrySimilarity =
    recall + precision > 0
      ? (2 * recall * precision) / (recall + precision)
      : 0;

  // Vergelijk ook totale hoeveelheid randen.
  const maxDensity = Math.max(referenceEdgeDensity, currentEdgeDensity, 0.00001);
  const densityAgreement =
    1 -
    Math.min(
      1,
      Math.abs(referenceEdgeDensity - currentEdgeDensity) / maxDensity,
    );

  // Geometrie weegt het zwaarst.
  const similarity =
    edgeGeometrySimilarity * 0.82 +
    densityAgreement * 0.18;

  return {
    ...zone,
    similarity,
    referenceEdgeDensity,
    currentEdgeDensity,
    densityAgreement,
    pass: similarity >= zone.minSimilarity,
  };
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function resultFor(zones: ZoneComparisonResult[], id: string) {
  return zones.find((zone) => zone.id === id);
}

/**
 * Definitieve controle:
 * NIEUWE genormaliseerde camerafoto versus de opgeslagen correcte
 * genormaliseerde referentiefoto.
 */
export function compareProduct1WithReference(
  current: ImageData,
  reference: ImageData,
  detectedTags: number[],
): InspectionResult {
  if (
    current.width !== NORMALIZED_WIDTH ||
    current.height !== NORMALIZED_HEIGHT ||
    reference.width !== NORMALIZED_WIDTH ||
    reference.height !== NORMALIZED_HEIGHT
  ) {
    throw new Error('Beelden hebben niet dezelfde 810 × 650 normalisatie.');
  }

  const referenceEdges = createEdgeMap(reference);
  const currentEdges = createEdgeMap(current);

  const zones = PRODUCT1_COMPARISON_ZONES.map((zone) =>
    compareZone(
      referenceEdges,
      currentEdges,
      NORMALIZED_WIDTH,
      NORMALIZED_HEIGHT,
      zone,
    ),
  );

  const wheelIds = [
    'wheelTopLeft',
    'wheelTopRight',
    'wheelBottomLeft',
    'wheelBottomRight',
  ];

  const wheelResults = wheelIds
    .map((id) => resultFor(zones, id))
    .filter((result): result is ZoneComparisonResult => Boolean(result));

  const handleResult = resultFor(zones, 'handle');
  const topResult = resultFor(zones, 'topProfile');
  const bottomResult = resultFor(zones, 'bottomProfile');
  const centerResult = resultFor(zones, 'centerProfile');

  const wheels =
    wheelResults.length === 4 &&
    wheelResults.every((result) => result.pass);

  const topProfile = Boolean(topResult?.pass);
  const bottomProfile = Boolean(bottomResult?.pass);
  const centerProfile = Boolean(centerResult?.pass);
  const handle = Boolean(handleResult?.pass);

  const wheelScore = average(wheelResults.map((result) => result.similarity));

  const errors: string[] = [];

  if (!handle) {
    errors.push(
      `Handvat wijkt af van referentie (${Math.round((handleResult?.similarity ?? 0) * 100)}% match)`,
    );
  }

  if (!topProfile) {
    errors.push(
      `Bovenprofiel wijkt af van referentie (${Math.round((topResult?.similarity ?? 0) * 100)}% match)`,
    );
  }

  if (!bottomProfile) {
    errors.push(
      `Onderprofiel wijkt af van referentie (${Math.round((bottomResult?.similarity ?? 0) * 100)}% match)`,
    );
  }

  if (!centerProfile) {
    errors.push(
      `Middenprofiel wijkt af van referentie (${Math.round((centerResult?.similarity ?? 0) * 100)}% match)`,
    );
  }

  wheelResults.forEach((result) => {
    if (!result.pass) {
      errors.push(
        `${result.label} wijkt af van referentie (${Math.round(result.similarity * 100)}% match)`,
      );
    }
  });

  const overallSimilarity = average(zones.map((zone) => zone.similarity));

  const status =
    wheels &&
    topProfile &&
    bottomProfile &&
    centerProfile &&
    handle
      ? 'ok'
      : 'error';

  return {
    status,
    context: 'final-qc',
    product: 'product1',
    detectedTags,
    overallSimilarity,
    checks: {
      wheels,
      topProfile,
      bottomProfile,
      centerProfile,
      handle,
    },
    scores: {
      wheels: wheelScore,
      topProfile: topResult?.similarity ?? 0,
      bottomProfile: bottomResult?.similarity ?? 0,
      centerProfile: centerResult?.similarity ?? 0,
      handle: handleResult?.similarity ?? 0,
    },
    errors,
    zones,
    timestamp: Date.now(),
  };
}
