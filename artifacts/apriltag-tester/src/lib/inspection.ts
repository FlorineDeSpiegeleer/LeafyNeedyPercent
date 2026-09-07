export type Point = { x: number; y: number };

export type Detection = {
  id: number;
  corners: Point[];
  center?: Point;
};

export type ProductId = "product1" | "product2";

export type StoredReference = {
  product: ProductId;
  imageUrl: string;
  createdAt: number;
};

export type OverlayInspectionResult = {
  status: "ok" | "nok";
  product: ProductId;
  score: number;
  expectedContourFound: number;
  currentContourInsideTolerance: number;
  referenceEdgePixels: number;
  currentEdgePixels: number;
  threshold: number;
  overlayUrl: string;
};

export const NORMALIZED_WIDTH = 810;
export const NORMALIZED_HEIGHT = 650;

/**
 * 95% was the requested acceptance rule.
 * If real testing proves this too strict, lower only this number.
 */
export const CONTOUR_MATCH_THRESHOLD = 0.95;

/**
 * A few pixels of movement are allowed after perspective correction.
 * 7 px on an 810 × 650 image is deliberately small but realistic.
 */
export const CONTOUR_TOLERANCE_PX = 7;

export const REFERENCE_KEYS: Record<ProductId, string> = {
  product1: "sirris-overlay-reference-product1-v1",
  product2: "sirris-overlay-reference-product2-v1",
};

function centerOf(detection: Detection): Point {
  if (detection.center) return detection.center;

  return detection.corners.reduce(
    (sum, p) => ({
      x: sum.x + p.x / detection.corners.length,
      y: sum.y + p.y / detection.corners.length,
    }),
    { x: 0, y: 0 },
  );
}

function solveLinearSystem(matrix: number[][], values: number[]): number[] | null {
  const n = values.length;
  const a = matrix.map((row, i) => [...row, values[i]]);

  for (let col = 0; col < n; col += 1) {
    let pivot = col;

    for (let row = col + 1; row < n; row += 1) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }

    if (Math.abs(a[pivot][col]) < 1e-10) return null;

    [a[col], a[pivot]] = [a[pivot], a[col]];

    const divisor = a[col][col];
    for (let j = col; j <= n; j += 1) a[col][j] /= divisor;

    for (let row = 0; row < n; row += 1) {
      if (row === col) continue;
      const factor = a[row][col];
      for (let j = col; j <= n; j += 1) {
        a[row][j] -= factor * a[col][j];
      }
    }
  }

  return a.map((row) => row[n]);
}

function homographyFromFourPoints(from: Point[], to: Point[]): number[] | null {
  const matrix: number[][] = [];
  const values: number[] = [];

  from.forEach((p, i) => {
    const q = to[i];

    matrix.push([
      p.x, p.y, 1,
      0, 0, 0,
      -q.x * p.x, -q.x * p.y,
    ]);
    values.push(q.x);

    matrix.push([
      0, 0, 0,
      p.x, p.y, 1,
      -q.y * p.x, -q.y * p.y,
    ]);
    values.push(q.y);
  });

  const h = solveLinearSystem(matrix, values);
  return h ? [...h, 1] : null;
}

/**
 * AprilTag layout:
 * ID 0 = top-left
 * ID 1 = top-right
 * ID 2 = bottom-left
 * ID 3 = bottom-right
 *
 * The tag CENTRES define the physical 810 × 650 reference rectangle.
 */
export function normalizeImage(
  source: ImageData,
  detections: Detection[],
): ImageData | null {
  const byId = new Map(detections.map((d) => [d.id, d]));

  const sourcePoints = [0, 1, 3, 2]
    .map((id) => byId.get(id))
    .filter((d): d is Detection => Boolean(d))
    .map(centerOf);

  if (sourcePoints.length !== 4) return null;

  const destinationPoints: Point[] = [
    { x: 0, y: 0 },
    { x: NORMALIZED_WIDTH - 1, y: 0 },
    { x: NORMALIZED_WIDTH - 1, y: NORMALIZED_HEIGHT - 1 },
    { x: 0, y: NORMALIZED_HEIGHT - 1 },
  ];

  // destination -> source, so we can sample every output pixel.
  const h = homographyFromFourPoints(destinationPoints, sourcePoints);
  if (!h) return null;

  const output = new ImageData(NORMALIZED_WIDTH, NORMALIZED_HEIGHT);

  for (let y = 0; y < NORMALIZED_HEIGHT; y += 1) {
    for (let x = 0; x < NORMALIZED_WIDTH; x += 1) {
      const denominator = h[6] * x + h[7] * y + h[8];
      const sx = (h[0] * x + h[1] * y + h[2]) / denominator;
      const sy = (h[3] * x + h[4] * y + h[5]) / denominator;
      const out = (y * NORMALIZED_WIDTH + x) * 4;

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < 0 ||
        sy < 0 ||
        sx >= source.width - 1 ||
        sy >= source.height - 1
      ) {
        output.data[out] = 240;
        output.data[out + 1] = 240;
        output.data[out + 2] = 240;
        output.data[out + 3] = 255;
        continue;
      }

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

export function imageDataToUrl(imageData: ImageData, quality = 0.94): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/jpeg", quality);
}

export async function imageUrlToImageData(url: string): Promise<ImageData> {
  const image = new Image();

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Reference image could not be loaded."));
    image.src = url;
  });

  const canvas = document.createElement("canvas");
  canvas.width = NORMALIZED_WIDTH;
  canvas.height = NORMALIZED_HEIGHT;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  ctx.drawImage(image, 0, 0, NORMALIZED_WIDTH, NORMALIZED_HEIGHT);
  return ctx.getImageData(0, 0, NORMALIZED_WIDTH, NORMALIZED_HEIGHT);
}

function luminance(image: ImageData, x: number, y: number): number {
  const i = (y * image.width + x) * 4;
  return (
    image.data[i] * 0.299 +
    image.data[i + 1] * 0.587 +
    image.data[i + 2] * 0.114
  );
}

function blurredGray(image: ImageData): Float32Array {
  const { width, height } = image;
  const gray = new Float32Array(width * height);
  const blur = new Float32Array(width * height);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      gray[y * width + x] = luminance(image, x, y);
    }
  }

  // 3 × 3 mean blur reduces sensor noise and tiny reflections.
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      let sum = 0;

      for (let oy = -1; oy <= 1; oy += 1) {
        for (let ox = -1; ox <= 1; ox += 1) {
          sum += gray[(y + oy) * width + (x + ox)];
        }
      }

      blur[y * width + x] = sum / 9;
    }
  }

  return blur;
}

function createEdgeMap(image: ImageData): Uint8Array {
  const { width, height } = image;
  const gray = blurredGray(image);
  const edges = new Uint8Array(width * height);

  // Tuned to keep strong product contours and suppress subtle lighting gradients.
  const EDGE_THRESHOLD = 38;

  for (let y = 2; y < height - 2; y += 1) {
    for (let x = 2; x < width - 2; x += 1) {
      const left = gray[y * width + x - 1];
      const right = gray[y * width + x + 1];
      const top = gray[(y - 1) * width + x];
      const bottom = gray[(y + 1) * width + x];

      const gradient = Math.abs(right - left) + Math.abs(bottom - top);

      if (gradient >= EDGE_THRESHOLD) {
        edges[y * width + x] = 1;
      }
    }
  }

  /**
   * Ignore a thin outer border.
   * The AprilTags themselves live at the corners and must not dominate
   * the product contour score.
   */
  const marginX = Math.round(width * 0.035);
  const marginY = Math.round(height * 0.035);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (
        x < marginX ||
        y < marginY ||
        x >= width - marginX ||
        y >= height - marginY
      ) {
        edges[y * width + x] = 0;
      }
    }
  }

  return edges;
}

function dilate(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(source.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;

      for (let oy = -radius; oy <= radius; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          if (ox * ox + oy * oy > radius * radius) continue;

          const nx = x + ox;
          const ny = y + oy;

          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          out[ny * width + nx] = 1;
        }
      }
    }
  }

  return out;
}

function countOnes(map: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < map.length; i += 1) count += map[i] ? 1 : 0;
  return count;
}

function createOverlayUrl(
  current: ImageData,
  referenceEdges: Uint8Array,
  currentEdges: Uint8Array,
  dilatedReference: Uint8Array,
  dilatedCurrent: Uint8Array,
): string {
  const canvas = document.createElement("canvas");
  canvas.width = current.width;
  canvas.height = current.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas unavailable");

  ctx.putImageData(current, 0, 0);

  const overlay = ctx.createImageData(current.width, current.height);

  for (let i = 0; i < referenceEdges.length; i += 1) {
    const p = i * 4;

    /**
     * GREEN = contour expected from the perfect reference and found nearby.
     * YELLOW = expected reference contour is missing.
     * RED = current contour exists outside the reference tolerance band.
     */
    if (referenceEdges[i]) {
      if (dilatedCurrent[i]) {
        overlay.data[p] = 34;
        overlay.data[p + 1] = 197;
        overlay.data[p + 2] = 94;
        overlay.data[p + 3] = 230;
      } else {
        overlay.data[p] = 245;
        overlay.data[p + 1] = 158;
        overlay.data[p + 2] = 11;
        overlay.data[p + 3] = 245;
      }
    }

    if (currentEdges[i] && !dilatedReference[i]) {
      overlay.data[p] = 220;
      overlay.data[p + 1] = 38;
      overlay.data[p + 2] = 38;
      overlay.data[p + 3] = 245;
    }
  }

  const overlayCanvas = document.createElement("canvas");
  overlayCanvas.width = current.width;
  overlayCanvas.height = current.height;
  overlayCanvas.getContext("2d")?.putImageData(overlay, 0, 0);

  ctx.globalAlpha = 0.9;
  ctx.drawImage(overlayCanvas, 0, 0);

  return canvas.toDataURL("image/jpeg", 0.94);
}

export function inspectAgainstReference(
  product: ProductId,
  current: ImageData,
  reference: ImageData,
): OverlayInspectionResult {
  const width = NORMALIZED_WIDTH;
  const height = NORMALIZED_HEIGHT;

  const referenceEdges = createEdgeMap(reference);
  const currentEdges = createEdgeMap(current);

  const dilatedReference = dilate(
    referenceEdges,
    width,
    height,
    CONTOUR_TOLERANCE_PX,
  );

  const dilatedCurrent = dilate(
    currentEdges,
    width,
    height,
    CONTOUR_TOLERANCE_PX,
  );

  let referenceMatched = 0;
  let currentMatched = 0;

  const referenceEdgePixels = countOnes(referenceEdges);
  const currentEdgePixels = countOnes(currentEdges);

  for (let i = 0; i < referenceEdges.length; i += 1) {
    if (referenceEdges[i] && dilatedCurrent[i]) referenceMatched += 1;
    if (currentEdges[i] && dilatedReference[i]) currentMatched += 1;
  }

  const expectedContourFound =
    referenceEdgePixels > 0 ? referenceMatched / referenceEdgePixels : 0;

  const currentContourInsideTolerance =
    currentEdgePixels > 0 ? currentMatched / currentEdgePixels : 0;

  /**
   * Both conditions must pass.
   * This catches:
   * - missing components: reference contour is not found;
   * - misplaced / extra components: current contour leaves the allowed band.
   */
  const score = Math.min(
    expectedContourFound,
    currentContourInsideTolerance,
  );

  const status =
    expectedContourFound >= CONTOUR_MATCH_THRESHOLD &&
    currentContourInsideTolerance >= CONTOUR_MATCH_THRESHOLD
      ? "ok"
      : "nok";

  return {
    status,
    product,
    score,
    expectedContourFound,
    currentContourInsideTolerance,
    referenceEdgePixels,
    currentEdgePixels,
    threshold: CONTOUR_MATCH_THRESHOLD,
    overlayUrl: createOverlayUrl(
      current,
      referenceEdges,
      currentEdges,
      dilatedReference,
      dilatedCurrent,
    ),
  };
}

export function saveReference(
  product: ProductId,
  normalizedImageUrl: string,
): void {
  const value: StoredReference = {
    product,
    imageUrl: normalizedImageUrl,
    createdAt: Date.now(),
  };

  localStorage.setItem(REFERENCE_KEYS[product], JSON.stringify(value));
}

export function loadReference(product: ProductId): StoredReference | null {
  try {
    const raw = localStorage.getItem(REFERENCE_KEYS[product]);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredReference;

    if (!parsed.imageUrl || parsed.product !== product) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function deleteReference(product: ProductId): void {
  localStorage.removeItem(REFERENCE_KEYS[product]);
}
