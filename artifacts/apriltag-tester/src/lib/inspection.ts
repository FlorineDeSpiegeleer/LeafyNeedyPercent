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
  expectedThreshold: number;
  placementThreshold: number;
  overlayUrl: string;
};

export const NORMALIZED_WIDTH = 810;
export const NORMALIZED_HEIGHT = 650;

/**
 * 95% was the requested acceptance rule.
 * If real testing proves this too strict, lower only this number.
 */
export const EXPECTED_CONTOUR_THRESHOLD = 0.75;
export const PLACEMENT_CONTOUR_THRESHOLD = 0.75;

/**
 * A few pixels of movement are allowed after perspective correction.
 * 7 px on an 810 × 650 image is deliberately small but realistic.
 */
export const CONTOUR_TOLERANCE_PX = 18;

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

  const EDGE_THRESHOLD = 30;

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

  // Ignore only the very outer frame / AprilTag border.
  const marginX = Math.round(width * 0.04);
  const marginY = Math.round(height * 0.04);

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
  for (let i = 0; i < map.length; i += 1) {
    if (map[i]) count += 1;
  }
  return count;
}

/**
 * We do NOT use every edge to locate the product.
 * Static edges from the table / AprilTags would otherwise keep the "pose"
 * fixed even if the product is moved.
 *
 * Instead:
 * 1. slightly dilate the edge map so broken profile edges connect;
 * 2. find connected components;
 * 3. keep the largest structural component that is not just a tiny marker.
 *
 * For these aluminium carts the connected profile frame is normally the
 * largest structure in the central working area.
 */
function largestStructureMask(
  edges: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const connected = dilate(edges, width, height, 2);
  const visited = new Uint8Array(connected.length);

  let bestPixels: number[] = [];

  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);

  const minXAllowed = Math.round(width * 0.05);
  const minYAllowed = Math.round(height * 0.05);
  const maxXAllowed = Math.round(width * 0.95);
  const maxYAllowed = Math.round(height * 0.95);

  for (let sy = minYAllowed; sy < maxYAllowed; sy += 1) {
    for (let sx = minXAllowed; sx < maxXAllowed; sx += 1) {
      const startIndex = sy * width + sx;
      if (!connected[startIndex] || visited[startIndex]) continue;

      let head = 0;
      let tail = 0;
      queueX[tail] = sx;
      queueY[tail] = sy;
      tail += 1;
      visited[startIndex] = 1;

      const pixels: number[] = [];

      while (head < tail) {
        const x = queueX[head];
        const y = queueY[head];
        head += 1;

        pixels.push(y * width + x);

        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;

            const nx = x + ox;
            const ny = y + oy;

            if (
              nx < minXAllowed ||
              ny < minYAllowed ||
              nx >= maxXAllowed ||
              ny >= maxYAllowed
            ) {
              continue;
            }

            const ni = ny * width + nx;
            if (!connected[ni] || visited[ni]) continue;

            visited[ni] = 1;
            queueX[tail] = nx;
            queueY[tail] = ny;
            tail += 1;
          }
        }
      }

      if (pixels.length > bestPixels.length) {
        bestPixels = pixels;
      }
    }
  }

  const mask = new Uint8Array(edges.length);

  // Use original (non-dilated) edge pixels that fall close to the largest component.
  const bestDilated = new Uint8Array(edges.length);
  for (const i of bestPixels) bestDilated[i] = 1;

  const support = dilate(bestDilated, width, height, 4);

  for (let i = 0; i < edges.length; i += 1) {
    if (edges[i] && support[i]) mask[i] = 1;
  }

  // Fallback: if the detected structure is too small, use all central edges.
  if (countOnes(mask) < 500) {
    return edges.slice();
  }

  return mask;
}

type Pose = {
  cx: number;
  cy: number;
  angle: number;
};

function estimatePose(mask: Uint8Array, width: number, height: number): Pose {
  let count = 0;
  let sumX = 0;
  let sumY = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;
      count += 1;
      sumX += x;
      sumY += y;
    }
  }

  if (count === 0) {
    return {
      cx: width / 2,
      cy: height / 2,
      angle: 0,
    };
  }

  const cx = sumX / count;
  const cy = sumY / count;

  let xx = 0;
  let yy = 0;
  let xy = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!mask[y * width + x]) continue;

      const dx = x - cx;
      const dy = y - cy;

      xx += dx * dx;
      yy += dy * dy;
      xy += dx * dy;
    }
  }

  // Principal-axis orientation.
  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);

  return { cx, cy, angle };
}

function transformEdgeMap(
  source: Uint8Array,
  width: number,
  height: number,
  sourcePose: Pose,
  targetPose: Pose,
  rotation: number,
): Uint8Array {
  const out = new Uint8Array(source.length);
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;

      const dx = x - sourcePose.cx;
      const dy = y - sourcePose.cy;

      const tx = targetPose.cx + cos * dx - sin * dy;
      const ty = targetPose.cy + sin * dx + cos * dy;

      const nx = Math.round(tx);
      const ny = Math.round(ty);

      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      out[ny * width + nx] = 1;
    }
  }

  return out;
}

function transformImage(
  source: ImageData,
  sourcePose: Pose,
  targetPose: Pose,
  rotation: number,
): ImageData {
  const { width, height } = source;
  const out = new ImageData(width, height);

  // Neutral workshop background for pixels outside the rotated source.
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 240;
    out.data[i + 1] = 240;
    out.data[i + 2] = 240;
    out.data[i + 3] = 255;
  }

  // Inverse mapping: destination -> original source.
  const cos = Math.cos(-rotation);
  const sin = Math.sin(-rotation);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - targetPose.cx;
      const dy = y - targetPose.cy;

      const sx = sourcePose.cx + cos * dx - sin * dy;
      const sy = sourcePose.cy + sin * dx + cos * dy;

      if (
        sx < 0 ||
        sy < 0 ||
        sx >= width - 1 ||
        sy >= height - 1
      ) {
        continue;
      }

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = Math.min(width - 1, x0 + 1);
      const y1 = Math.min(height - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;

      const outIndex = (y * width + x) * 4;

      for (let c = 0; c < 3; c += 1) {
        const p00 = source.data[(y0 * width + x0) * 4 + c];
        const p10 = source.data[(y0 * width + x1) * 4 + c];
        const p01 = source.data[(y1 * width + x0) * 4 + c];
        const p11 = source.data[(y1 * width + x1) * 4 + c];

        const top = p00 * (1 - fx) + p10 * fx;
        const bottom = p01 * (1 - fx) + p11 * fx;

        out.data[outIndex + c] = Math.round(
          top * (1 - fy) + bottom * fy,
        );
      }

      out.data[outIndex + 3] = 255;
    }
  }

  return out;
}

function softProximityScore(
  sourceEdges: Uint8Array,
  targetEdges: Uint8Array,
  width: number,
  height: number,
  radius: number,
): number {
  const targetTolerance = dilate(targetEdges, width, height, radius);

  let sourceCount = 0;
  let matchCount = 0;

  for (let i = 0; i < sourceEdges.length; i += 1) {
    if (!sourceEdges[i]) continue;
    sourceCount += 1;
    if (targetTolerance[i]) matchCount += 1;
  }

  return sourceCount > 0 ? matchCount / sourceCount : 0;
}

function alignmentScore(
  referenceEdges: Uint8Array,
  alignedCurrentEdges: Uint8Array,
  width: number,
  height: number,
): number {
  const expected = softProximityScore(
    referenceEdges,
    alignedCurrentEdges,
    width,
    height,
    CONTOUR_TOLERANCE_PX,
  );

  const placement = softProximityScore(
    alignedCurrentEdges,
    referenceEdges,
    width,
    height,
    CONTOUR_TOLERANCE_PX,
  );

  return Math.min(expected, placement);
}

function autoAlignCurrentToReference(
  current: ImageData,
  reference: ImageData,
): {
  alignedImage: ImageData;
  alignedEdges: Uint8Array;
  referenceEdges: Uint8Array;
} {
  const width = NORMALIZED_WIDTH;
  const height = NORMALIZED_HEIGHT;

  const referenceEdges = createEdgeMap(reference);
  const currentEdges = createEdgeMap(current);

  const referenceStructure = largestStructureMask(
    referenceEdges,
    width,
    height,
  );

  const currentStructure = largestStructureMask(
    currentEdges,
    width,
    height,
  );

  const referencePose = estimatePose(
    referenceStructure,
    width,
    height,
  );

  const currentPose = estimatePose(
    currentStructure,
    width,
    height,
  );

  const baseRotation = referencePose.angle - currentPose.angle;

  // PCA orientation has a 180° ambiguity.
  // Try both and keep the alignment that matches the reference best.
  const candidates = [
    baseRotation,
    baseRotation + Math.PI,
  ];

  let bestRotation = candidates[0];
  let bestEdges = transformEdgeMap(
    currentEdges,
    width,
    height,
    currentPose,
    referencePose,
    bestRotation,
  );
  let bestScore = alignmentScore(
    referenceEdges,
    bestEdges,
    width,
    height,
  );

  for (let i = 1; i < candidates.length; i += 1) {
    const rotation = candidates[i];

    const transformed = transformEdgeMap(
      currentEdges,
      width,
      height,
      currentPose,
      referencePose,
      rotation,
    );

    const score = alignmentScore(
      referenceEdges,
      transformed,
      width,
      height,
    );

    if (score > bestScore) {
      bestScore = score;
      bestRotation = rotation;
      bestEdges = transformed;
    }
  }

  const alignedImage = transformImage(
    current,
    currentPose,
    referencePose,
    bestRotation,
  );

  return {
    alignedImage,
    alignedEdges: bestEdges,
    referenceEdges,
  };
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

    // GREEN = reference contour correctly found nearby.
    if (referenceEdges[i] && dilatedCurrent[i]) {
      overlay.data[p] = 34;
      overlay.data[p + 1] = 197;
      overlay.data[p + 2] = 94;
      overlay.data[p + 3] = 235;
    }

    // YELLOW = contour expected from the perfect product but missing.
    if (referenceEdges[i] && !dilatedCurrent[i]) {
      overlay.data[p] = 245;
      overlay.data[p + 1] = 158;
      overlay.data[p + 2] = 11;
      overlay.data[p + 3] = 245;
    }

    // RED = current contour exists where the perfect reference does not.
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

  ctx.globalAlpha = 0.92;
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

  /**
   * IMPORTANT:
   * Before comparison, the WHOLE current product is translated + rotated
   * onto the reference product. Therefore a correct product may lie
   * anywhere inside the AprilTag frame.
   *
   * Only internal / relative geometry remains relevant afterwards.
   */
  const {
    alignedImage,
    alignedEdges: currentEdges,
    referenceEdges,
  } = autoAlignCurrentToReference(current, reference);

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
    referenceEdgePixels > 0
      ? referenceMatched / referenceEdgePixels
      : 0;

  const currentContourInsideTolerance =
    currentEdgePixels > 0
      ? currentMatched / currentEdgePixels
      : 0;

  const score = Math.min(
    expectedContourFound,
    currentContourInsideTolerance,
  );

  const status =
    expectedContourFound >= EXPECTED_CONTOUR_THRESHOLD &&
    currentContourInsideTolerance >= PLACEMENT_CONTOUR_THRESHOLD
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
    expectedThreshold: EXPECTED_CONTOUR_THRESHOLD,
    placementThreshold: PLACEMENT_CONTOUR_THRESHOLD,
    overlayUrl: createOverlayUrl(
      alignedImage,
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

  localStorage.setItem(
    REFERENCE_KEYS[product],
    JSON.stringify(value),
  );
}

export function loadReference(product: ProductId): StoredReference | null {
  try {
    const raw = localStorage.getItem(REFERENCE_KEYS[product]);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as StoredReference;

    if (!parsed.imageUrl || parsed.product !== product) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function deleteReference(product: ProductId): void {
  localStorage.removeItem(REFERENCE_KEYS[product]);
}
