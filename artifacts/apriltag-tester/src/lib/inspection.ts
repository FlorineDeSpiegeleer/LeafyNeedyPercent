from pathlib import Path
import zipfile, shutil, re

# Use previous auto-align version as base so only inspection.ts changes again.
src_zip = Path("/mnt/data/AprilTag_AutoAlign_Fix.zip")
work = Path("/mnt/data/AprilTag_AutoAlign_MaskSearch")
if work.exists():
    shutil.rmtree(work)
work.mkdir(parents=True)

with zipfile.ZipFile(src_zip) as z:
    z.extractall(work)

inspection_path = next(work.rglob("src/lib/inspection.ts"))
text = inspection_path.read_text(encoding="utf-8")

# We'll replace everything from createEdgeMap onward with a more robust
# mask + angle/translation search registration.
marker = "function createEdgeMap(image: ImageData): Uint8Array {"
prefix = text[:text.index(marker)]

tail = r'''
function createEdgeMap(image: ImageData): Uint8Array {
  const { width, height } = image;
  const gray = blurredGray(image);
  const edges = new Uint8Array(width * height);

  const EDGE_THRESHOLD = 28;

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

  const marginX = Math.round(width * 0.045);
  const marginY = Math.round(height * 0.045);

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

function erode(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const out = new Uint8Array(source.length);

  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      let keep = true;

      for (let oy = -radius; oy <= radius && keep; oy += 1) {
        for (let ox = -radius; ox <= radius; ox += 1) {
          if (ox * ox + oy * oy > radius * radius) continue;

          if (!source[(y + oy) * width + (x + ox)]) {
            keep = false;
            break;
          }
        }
      }

      if (keep) out[y * width + x] = 1;
    }
  }

  return out;
}

function closeMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return erode(
    dilate(source, width, height, radius),
    width,
    height,
    radius,
  );
}

function countOnes(map: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < map.length; i += 1) {
    if (map[i]) count += 1;
  }
  return count;
}

function rgbAt(image: ImageData, x: number, y: number) {
  const i = (y * image.width + x) * 4;
  return {
    r: image.data[i],
    g: image.data[i + 1],
    b: image.data[i + 2],
  };
}

/**
 * Product mask for this specific demo:
 * - aluminium tends to be brighter / lower saturation
 * - wheels / handle tend to be dark
 *
 * We intentionally ignore middle-grey floor/background as much as possible.
 * This is only used for GLOBAL product registration. Final acceptance is still
 * based on contour comparison, not on this crude mask.
 */
function createProductMask(image: ImageData): Uint8Array {
  const { width, height } = image;
  const mask = new Uint8Array(width * height);

  const minX = Math.round(width * 0.05);
  const maxX = Math.round(width * 0.95);
  const minY = Math.round(height * 0.05);
  const maxY = Math.round(height * 0.95);

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const { r, g, b } = rgbAt(image, x, y);

      const maxC = Math.max(r, g, b);
      const minC = Math.min(r, g, b);
      const saturation = maxC - minC;
      const brightness = (r + g + b) / 3;

      const brightAluminium =
        brightness >= 150 &&
        saturation <= 70;

      const darkComponent =
        brightness <= 75;

      if (brightAluminium || darkComponent) {
        mask[y * width + x] = 1;
      }
    }
  }

  // Connect nearby pieces of the same cart and remove isolated noise.
  let cleaned = closeMask(mask, width, height, 3);
  cleaned = dilate(cleaned, width, height, 2);

  return largestConnectedComponent(cleaned, width, height);
}

function largestConnectedComponent(
  source: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const visited = new Uint8Array(source.length);
  let best: number[] = [];

  const qx = new Int32Array(width * height);
  const qy = new Int32Array(width * height);

  for (let sy = 0; sy < height; sy += 1) {
    for (let sx = 0; sx < width; sx += 1) {
      const si = sy * width + sx;
      if (!source[si] || visited[si]) continue;

      let head = 0;
      let tail = 0;

      qx[tail] = sx;
      qy[tail] = sy;
      tail += 1;
      visited[si] = 1;

      const pixels: number[] = [];

      while (head < tail) {
        const x = qx[head];
        const y = qy[head];
        head += 1;

        pixels.push(y * width + x);

        for (let oy = -1; oy <= 1; oy += 1) {
          for (let ox = -1; ox <= 1; ox += 1) {
            if (ox === 0 && oy === 0) continue;

            const nx = x + ox;
            const ny = y + oy;

            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;

            const ni = ny * width + nx;
            if (!source[ni] || visited[ni]) continue;

            visited[ni] = 1;
            qx[tail] = nx;
            qy[tail] = ny;
            tail += 1;
          }
        }
      }

      if (pixels.length > best.length) best = pixels;
    }
  }

  const out = new Uint8Array(source.length);
  for (const i of best) out[i] = 1;

  return out;
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

  if (count < 100) {
    return { cx: width / 2, cy: height / 2, angle: 0 };
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

  const angle = 0.5 * Math.atan2(2 * xy, xx - yy);

  return { cx, cy, angle };
}

function transformPoint(
  x: number,
  y: number,
  sourcePose: Pose,
  targetPose: Pose,
  rotation: number,
) {
  const dx = x - sourcePose.cx;
  const dy = y - sourcePose.cy;

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);

  return {
    x: targetPose.cx + cos * dx - sin * dy,
    y: targetPose.cy + sin * dx + cos * dy,
  };
}

function transformBinaryMap(
  source: Uint8Array,
  width: number,
  height: number,
  sourcePose: Pose,
  targetPose: Pose,
  rotation: number,
): Uint8Array {
  const out = new Uint8Array(source.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (!source[y * width + x]) continue;

      const p = transformPoint(
        x,
        y,
        sourcePose,
        targetPose,
        rotation,
      );

      const nx = Math.round(p.x);
      const ny = Math.round(p.y);

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

  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 238;
    out.data[i + 1] = 238;
    out.data[i + 2] = 238;
    out.data[i + 3] = 255;
  }

  const invRotation = -rotation;
  const cos = Math.cos(invRotation);
  const sin = Math.sin(invRotation);

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

      const oi = (y * width + x) * 4;

      for (let c = 0; c < 3; c += 1) {
        const p00 = source.data[(y0 * width + x0) * 4 + c];
        const p10 = source.data[(y0 * width + x1) * 4 + c];
        const p01 = source.data[(y1 * width + x0) * 4 + c];
        const p11 = source.data[(y1 * width + x1) * 4 + c];

        const top = p00 * (1 - fx) + p10 * fx;
        const bottom = p01 * (1 - fx) + p11 * fx;

        out.data[oi + c] = Math.round(
          top * (1 - fy) + bottom * fy,
        );
      }

      out.data[oi + 3] = 255;
    }
  }

  return out;
}

function overlapScore(
  a: Uint8Array,
  b: Uint8Array,
  width: number,
  height: number,
  tolerance: number,
): number {
  const bTol = dilate(b, width, height, tolerance);

  let total = 0;
  let matched = 0;

  for (let i = 0; i < a.length; i += 1) {
    if (!a[i]) continue;
    total += 1;
    if (bTol[i]) matched += 1;
  }

  return total > 0 ? matched / total : 0;
}

/**
 * Search registration:
 *
 * PCA gives us a rough product pose.
 * It is NOT trusted as the final rotation.
 *
 * Around that estimate we explicitly test many angles and small translations.
 * We choose the pose giving the best bidirectional mask overlap.
 *
 * This is much more robust than the previous "one PCA angle = truth" method.
 */
function findBestRegistration(
  currentMask: Uint8Array,
  referenceMask: Uint8Array,
  width: number,
  height: number,
): {
  currentPose: Pose;
  referencePose: Pose;
  rotation: number;
} {
  const currentPose = estimatePose(currentMask, width, height);
  const referencePose = estimatePose(referenceMask, width, height);

  const initial = referencePose.angle - currentPose.angle;

  let bestRotation = initial;
  let bestTargetPose: Pose = { ...referencePose };
  let bestScore = -1;

  const angleOffsetsDeg = [
    -90, -75, -60, -45, -30, -20, -15, -10, -5,
    0,
    5, 10, 15, 20, 30, 45, 60, 75, 90,
  ];

  // Also test the PCA-estimated orientation and its 180° ambiguity.
  const angleCandidates = new Set<number>();

  for (const deg of angleOffsetsDeg) {
    angleCandidates.add(initial + (deg * Math.PI) / 180);
    angleCandidates.add(initial + Math.PI + (deg * Math.PI) / 180);
  }

  const translationOffsets = [-24, -12, 0, 12, 24];

  for (const rotation of angleCandidates) {
    for (const dx of translationOffsets) {
      for (const dy of translationOffsets) {
        const targetPose: Pose = {
          cx: referencePose.cx + dx,
          cy: referencePose.cy + dy,
          angle: referencePose.angle,
        };

        const transformed = transformBinaryMap(
          currentMask,
          width,
          height,
          currentPose,
          targetPose,
          rotation,
        );

        const forward = overlapScore(
          referenceMask,
          transformed,
          width,
          height,
          10,
        );

        const backward = overlapScore(
          transformed,
          referenceMask,
          width,
          height,
          10,
        );

        const score = Math.min(forward, backward);

        if (score > bestScore) {
          bestScore = score;
          bestRotation = rotation;
          bestTargetPose = targetPose;
        }
      }
    }
  }

  return {
    currentPose,
    referencePose: bestTargetPose,
    rotation: bestRotation,
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

    if (referenceEdges[i] && dilatedCurrent[i]) {
      overlay.data[p] = 34;
      overlay.data[p + 1] = 197;
      overlay.data[p + 2] = 94;
      overlay.data[p + 3] = 235;
    }

    if (referenceEdges[i] && !dilatedCurrent[i]) {
      overlay.data[p] = 245;
      overlay.data[p + 1] = 158;
      overlay.data[p + 2] = 11;
      overlay.data[p + 3] = 245;
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

  // 1. Build rough product masks only for registration.
  const referenceMask = createProductMask(reference);
  const currentMask = createProductMask(current);

  // If mask extraction is very weak, we still continue with the edge maps,
  // but registration will naturally be less reliable.
  const registration = findBestRegistration(
    currentMask,
    referenceMask,
    width,
    height,
  );

  // 2. Apply ONE global translation + rotation to the whole current product.
  const alignedImage = transformImage(
    current,
    registration.currentPose,
    registration.referencePose,
    registration.rotation,
  );

  // 3. Only now create edge maps for the quality decision.
  const referenceEdges = createEdgeMap(reference);
  const currentEdges = createEdgeMap(alignedImage);

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
    if (referenceEdges[i] && dilatedCurrent[i]) {
      referenceMatched += 1;
    }

    if (currentEdges[i] && dilatedReference[i]) {
      currentMatched += 1;
    }
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

    if (!parsed.imageUrl || parsed.product !== product) return null;

    return parsed;
  } catch {
    return null;
  }
}

export function deleteReference(product: ProductId): void {
  localStorage.removeItem(REFERENCE_KEYS[product]);
}
'''

inspection_path.write_text(prefix + tail, encoding="utf-8")

# Create minimal package containing only the file the user needs.
package = Path("/mnt/data/AprilTag_MaskSearch_Fix")
if package.exists():
    shutil.rmtree(package)
(package / "artifacts" / "apriltag-tester" / "src" / "lib").mkdir(parents=True)

shutil.copy2(
    inspection_path,
    package / "artifacts" / "apriltag-tester" / "src" / "lib" / "inspection.ts"
)

(package / "README.txt").write_text(
"""ROBUST PRODUCT AUTO-REGISTRATION FIX

Vervang alleen:
artifacts/apriltag-tester/src/lib/inspection.ts

Wat verandert:
- Niet meer vertrouwen op ruwe edges voor de productpositie.
- Eerst een grof productmasker zoeken:
  * helder / laag-verzadigd aluminium
  * donkere wielen / handvat
- Alleen de grootste verbonden productstructuur wordt gebruikt.
- PCA geeft enkel een STARTSCHATTING van de pose.
- Daarna zoekt de app expliciet door meerdere rotaties en kleine verschuivingen.
- De pose met de beste bidirectionele overlap wordt gekozen.
- Vervolgens wordt het HELE huidige product virtueel uitgelijnd.
- Pas daarna gebeurt de bestaande contourvergelijking + OK/NOK.

Waarom:
Een correct product mag nu op een andere plek en onder een andere rotatie binnen
het AprilTag-kader liggen.

Bestaand blijft:
- AprilTag detector
- perspectiefcorrectie naar 810 × 650
- Product 1 / Product 2 referenties
- 75% / 75% drempels
- 18 px tolerantie
- overlay
- DigitalWorkstation integratie

Test:
1. Correct product op originele plaats
2. Correct product duidelijk verschoven
3. Correct product 20-45 graden gedraaid
4. Fout product, bv. handvat verwijderd

Let op:
De camera moet nog steeds ongeveer top-down zijn. Een 2D-homografie kan echte 3D-parallax
van een sterke schuine camerahoek niet oplossen.
""",
encoding="utf-8"
)

zip_path = Path("/mnt/data/AprilTag_MaskSearch_Fix.zip")
if zip_path.exists():
    zip_path.unlink()

with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
    for p in package.rglob("*"):
        if p.is_file():
            z.write(p, p.relative_to(package))

print(zip_path)
