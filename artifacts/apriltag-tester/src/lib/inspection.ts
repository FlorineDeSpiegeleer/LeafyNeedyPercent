export type Point = {
  x: number;
  y: number;
};

export type Detection = {
  id: number;
  corners: Point[];
  center?: Point;
};

export type ProductId =
  | "product1"
  | "product2";

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

export const EXPECTED_CONTOUR_THRESHOLD = 0.75;
export const PLACEMENT_CONTOUR_THRESHOLD = 0.75;

export const CONTOUR_TOLERANCE_PX = 18;

export const REFERENCE_KEYS: Record<
  ProductId,
  string
> = {
  product1:
    "sirris-overlay-reference-product1-v1",
  product2:
    "sirris-overlay-reference-product2-v1",
};

/* =========================================================
   APRILTAG / HOMOGRAPHY
   ========================================================= */

function centerOf(
  detection: Detection,
): Point {
  if (detection.center) {
    return detection.center;
  }

  return detection.corners.reduce(
    (sum, point) => ({
      x:
        sum.x +
        point.x /
          detection.corners.length,
      y:
        sum.y +
        point.y /
          detection.corners.length,
    }),
    {
      x: 0,
      y: 0,
    },
  );
}

function solveLinearSystem(
  matrix: number[][],
  values: number[],
): number[] | null {
  const n = values.length;

  const augmented = matrix.map(
    (row, i) => [
      ...row,
      values[i],
    ],
  );

  for (
    let col = 0;
    col < n;
    col += 1
  ) {
    let pivot = col;

    for (
      let row = col + 1;
      row < n;
      row += 1
    ) {
      if (
        Math.abs(
          augmented[row][col],
        ) >
        Math.abs(
          augmented[pivot][col],
        )
      ) {
        pivot = row;
      }
    }

    if (
      Math.abs(
        augmented[pivot][col],
      ) < 1e-10
    ) {
      return null;
    }

    [
      augmented[col],
      augmented[pivot],
    ] = [
      augmented[pivot],
      augmented[col],
    ];

    const divisor =
      augmented[col][col];

    for (
      let j = col;
      j <= n;
      j += 1
    ) {
      augmented[col][j] /=
        divisor;
    }

    for (
      let row = 0;
      row < n;
      row += 1
    ) {
      if (row === col) {
        continue;
      }

      const factor =
        augmented[row][col];

      for (
        let j = col;
        j <= n;
        j += 1
      ) {
        augmented[row][j] -=
          factor *
          augmented[col][j];
      }
    }
  }

  return augmented.map(
    (row) => row[n],
  );
}

function homographyFromFourPoints(
  from: Point[],
  to: Point[],
): number[] | null {
  const matrix: number[][] = [];
  const values: number[] = [];

  from.forEach(
    (point, index) => {
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

      values.push(
        target.x,
      );

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

      values.push(
        target.y,
      );
    },
  );

  const h =
    solveLinearSystem(
      matrix,
      values,
    );

  return h
    ? [...h, 1]
    : null;
}

export function normalizeImage(
  source: ImageData,
  detections: Detection[],
): ImageData | null {
  const byId =
    new Map(
      detections.map(
        (detection) => [
          detection.id,
          detection,
        ],
      ),
    );

  /*
    Layout:
    0 = TL
    1 = TR
    2 = BL
    3 = BR
  */

  const sourcePoints = [
    0,
    1,
    3,
    2,
  ]
    .map(
      (id) =>
        byId.get(id),
    )
    .filter(
      (
        detection,
      ): detection is Detection =>
        Boolean(detection),
    )
    .map(centerOf);

  if (
    sourcePoints.length !== 4
  ) {
    return null;
  }

  const destinationPoints: Point[] =
    [
      {
        x: 0,
        y: 0,
      },
      {
        x:
          NORMALIZED_WIDTH -
          1,
        y: 0,
      },
      {
        x:
          NORMALIZED_WIDTH -
          1,
        y:
          NORMALIZED_HEIGHT -
          1,
      },
      {
        x: 0,
        y:
          NORMALIZED_HEIGHT -
          1,
      },
    ];

  const homography =
    homographyFromFourPoints(
      destinationPoints,
      sourcePoints,
    );

  if (!homography) {
    return null;
  }

  const output =
    new ImageData(
      NORMALIZED_WIDTH,
      NORMALIZED_HEIGHT,
    );

  for (
    let y = 0;
    y <
    NORMALIZED_HEIGHT;
    y += 1
  ) {
    for (
      let x = 0;
      x <
      NORMALIZED_WIDTH;
      x += 1
    ) {
      const denominator =
        homography[6] * x +
        homography[7] * y +
        homography[8];

      const sx =
        (
          homography[0] *
            x +
          homography[1] *
            y +
          homography[2]
        ) /
        denominator;

      const sy =
        (
          homography[3] *
            x +
          homography[4] *
            y +
          homography[5]
        ) /
        denominator;

      const outputIndex =
        (
          y *
            NORMALIZED_WIDTH +
          x
        ) *
        4;

      if (
        !Number.isFinite(sx) ||
        !Number.isFinite(sy) ||
        sx < 0 ||
        sy < 0 ||
        sx >=
          source.width - 1 ||
        sy >=
          source.height - 1
      ) {
        output.data[
          outputIndex
        ] = 240;

        output.data[
          outputIndex + 1
        ] = 240;

        output.data[
          outputIndex + 2
        ] = 240;

        output.data[
          outputIndex + 3
        ] = 255;

        continue;
      }

      const x0 =
        Math.floor(sx);

      const y0 =
        Math.floor(sy);

      const x1 =
        Math.min(
          source.width - 1,
          x0 + 1,
        );

      const y1 =
        Math.min(
          source.height - 1,
          y0 + 1,
        );

      const dx =
        sx - x0;

      const dy =
        sy - y0;

      for (
        let channel = 0;
        channel < 3;
        channel += 1
      ) {
        const p00 =
          source.data[
            (
              y0 *
                source.width +
              x0
            ) *
              4 +
              channel
          ];

        const p10 =
          source.data[
            (
              y0 *
                source.width +
              x1
            ) *
              4 +
              channel
          ];

        const p01 =
          source.data[
            (
              y1 *
                source.width +
              x0
            ) *
              4 +
              channel
          ];

        const p11 =
          source.data[
            (
              y1 *
                source.width +
              x1
            ) *
              4 +
              channel
          ];

        const top =
          p00 *
            (1 - dx) +
          p10 * dx;

        const bottom =
          p01 *
            (1 - dx) +
          p11 * dx;

        output.data[
          outputIndex +
            channel
        ] =
          Math.round(
            top *
              (1 - dy) +
              bottom * dy,
          );
      }

      output.data[
        outputIndex + 3
      ] = 255;
    }
  }

  return output;
}

/* =========================================================
   IMAGE CONVERSION
   ========================================================= */

export function imageDataToUrl(
  imageData: ImageData,
  quality = 0.94,
): string {
  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    imageData.width;

  canvas.height =
    imageData.height;

  const context =
    canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Canvas unavailable",
    );
  }

  context.putImageData(
    imageData,
    0,
    0,
  );

  return canvas.toDataURL(
    "image/jpeg",
    quality,
  );
}

export async function imageUrlToImageData(
  url: string,
): Promise<ImageData> {
  const image =
    new Image();

  await new Promise<void>(
    (
      resolve,
      reject,
    ) => {
      image.onload =
        () => resolve();

      image.onerror =
        () =>
          reject(
            new Error(
              "Reference image could not be loaded.",
            ),
          );

      image.src = url;
    },
  );

  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    NORMALIZED_WIDTH;

  canvas.height =
    NORMALIZED_HEIGHT;

  const context =
    canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Canvas unavailable",
    );
  }

  context.drawImage(
    image,
    0,
    0,
    NORMALIZED_WIDTH,
    NORMALIZED_HEIGHT,
  );

  return context.getImageData(
    0,
    0,
    NORMALIZED_WIDTH,
    NORMALIZED_HEIGHT,
  );
}

/* =========================================================
   BASIC IMAGE PROCESSING
   ========================================================= */

function luminance(
  image: ImageData,
  x: number,
  y: number,
): number {
  const index =
    (
      y *
        image.width +
      x
    ) *
    4;

  return (
    image.data[index] *
      0.299 +
    image.data[
      index + 1
    ] *
      0.587 +
    image.data[
      index + 2
    ] *
      0.114
  );
}

function blurredGray(
  image: ImageData,
): Float32Array {
  const {
    width,
    height,
  } = image;

  const gray =
    new Float32Array(
      width * height,
    );

  const blurred =
    new Float32Array(
      width * height,
    );

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      gray[
        y * width + x
      ] =
        luminance(
          image,
          x,
          y,
        );
    }
  }

  for (
    let y = 1;
    y < height - 1;
    y += 1
  ) {
    for (
      let x = 1;
      x < width - 1;
      x += 1
    ) {
      let sum = 0;

      for (
        let oy = -1;
        oy <= 1;
        oy += 1
      ) {
        for (
          let ox = -1;
          ox <= 1;
          ox += 1
        ) {
          sum +=
            gray[
              (
                y + oy
              ) *
                width +
                (
                  x + ox
                )
            ];
        }
      }

      blurred[
        y * width + x
      ] =
        sum / 9;
    }
  }

  return blurred;
}

function createEdgeMap(
  image: ImageData,
): Uint8Array {
  const {
    width,
    height,
  } = image;

  const gray =
    blurredGray(image);

  const edges =
    new Uint8Array(
      width * height,
    );

  const EDGE_THRESHOLD = 28;

  for (
    let y = 2;
    y < height - 2;
    y += 1
  ) {
    for (
      let x = 2;
      x < width - 2;
      x += 1
    ) {
      const left =
        gray[
          y *
            width +
            x -
            1
        ];

      const right =
        gray[
          y *
            width +
            x +
            1
        ];

      const top =
        gray[
          (
            y - 1
          ) *
            width +
            x
        ];

      const bottom =
        gray[
          (
            y + 1
          ) *
            width +
            x
        ];

      const gradient =
        Math.abs(
          right -
            left,
        ) +
        Math.abs(
          bottom -
            top,
        );

      if (
        gradient >=
        EDGE_THRESHOLD
      ) {
        edges[
          y *
            width +
            x
        ] = 1;
      }
    }
  }

  /*
    Buitenrand negeren zodat
    AprilTags / rand van werkvlak
    minder invloed hebben.
  */

  const marginX =
    Math.round(
      width * 0.045,
    );

  const marginY =
    Math.round(
      height * 0.045,
    );

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      if (
        x < marginX ||
        y < marginY ||
        x >=
          width -
            marginX ||
        y >=
          height -
            marginY
      ) {
        edges[
          y *
            width +
            x
        ] = 0;
      }
    }
  }

  return edges;
}

/* =========================================================
   MORPHOLOGY
   ========================================================= */

function dilate(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output =
    new Uint8Array(
      source.length,
    );

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      if (
        !source[
          y *
            width +
            x
        ]
      ) {
        continue;
      }

      for (
        let oy =
          -radius;
        oy <= radius;
        oy += 1
      ) {
        for (
          let ox =
            -radius;
          ox <= radius;
          ox += 1
        ) {
          if (
            ox * ox +
              oy * oy >
            radius *
              radius
          ) {
            continue;
          }

          const nx =
            x + ox;

          const ny =
            y + oy;

          if (
            nx < 0 ||
            ny < 0 ||
            nx >= width ||
            ny >= height
          ) {
            continue;
          }

          output[
            ny *
              width +
              nx
          ] = 1;
        }
      }
    }
  }

  return output;
}

function erode(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const output =
    new Uint8Array(
      source.length,
    );

  for (
    let y = radius;
    y <
    height - radius;
    y += 1
  ) {
    for (
      let x = radius;
      x <
      width - radius;
      x += 1
    ) {
      let keep = true;

      for (
        let oy =
          -radius;
        oy <= radius &&
        keep;
        oy += 1
      ) {
        for (
          let ox =
            -radius;
          ox <= radius;
          ox += 1
        ) {
          if (
            ox * ox +
              oy * oy >
            radius *
              radius
          ) {
            continue;
          }

          if (
            !source[
              (
                y + oy
              ) *
                width +
                (
                  x + ox
                )
            ]
          ) {
            keep = false;
            break;
          }
        }
      }

      if (keep) {
        output[
          y *
            width +
            x
        ] = 1;
      }
    }
  }

  return output;
}

function closeMask(
  source: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  return erode(
    dilate(
      source,
      width,
      height,
      radius,
    ),
    width,
    height,
    radius,
  );
}

function countOnes(
  map: Uint8Array,
): number {
  let count = 0;

  for (
    let index = 0;
    index <
    map.length;
    index += 1
  ) {
    if (map[index]) {
      count += 1;
    }
  }

  return count;
}

/* =========================================================
   PRODUCT MASK
   ========================================================= */

function rgbAt(
  image: ImageData,
  x: number,
  y: number,
) {
  const index =
    (
      y *
        image.width +
      x
    ) *
    4;

  return {
    r: image.data[index],
    g:
      image.data[
        index + 1
      ],
    b:
      image.data[
        index + 2
      ],
  };
}

function largestConnectedComponent(
  source: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const visited =
    new Uint8Array(
      source.length,
    );

  let best: number[] =
    [];

  const queueX =
    new Int32Array(
      width * height,
    );

  const queueY =
    new Int32Array(
      width * height,
    );

  for (
    let startY = 0;
    startY < height;
    startY += 1
  ) {
    for (
      let startX = 0;
      startX < width;
      startX += 1
    ) {
      const startIndex =
        startY *
          width +
        startX;

      if (
        !source[
          startIndex
        ] ||
        visited[
          startIndex
        ]
      ) {
        continue;
      }

      let head = 0;
      let tail = 0;

      queueX[tail] =
        startX;

      queueY[tail] =
        startY;

      tail += 1;

      visited[
        startIndex
      ] = 1;

      const pixels: number[] =
        [];

      while (
        head < tail
      ) {
        const x =
          queueX[head];

        const y =
          queueY[head];

        head += 1;

        pixels.push(
          y *
            width +
            x,
        );

        for (
          let oy = -1;
          oy <= 1;
          oy += 1
        ) {
          for (
            let ox = -1;
            ox <= 1;
            ox += 1
          ) {
            if (
              ox === 0 &&
              oy === 0
            ) {
              continue;
            }

            const nx =
              x + ox;

            const ny =
              y + oy;

            if (
              nx < 0 ||
              ny < 0 ||
              nx >= width ||
              ny >= height
            ) {
              continue;
            }

            const nextIndex =
              ny *
                width +
              nx;

            if (
              !source[
                nextIndex
              ] ||
              visited[
                nextIndex
              ]
            ) {
              continue;
            }

            visited[
              nextIndex
            ] = 1;

            queueX[tail] =
              nx;

            queueY[tail] =
              ny;

            tail += 1;
          }
        }
      }

      if (
        pixels.length >
        best.length
      ) {
        best = pixels;
      }
    }
  }

  const output =
    new Uint8Array(
      source.length,
    );

  for (
    const index
    of best
  ) {
    output[index] = 1;
  }

  return output;
}

/*
  Dit masker is enkel bedoeld
  om de globale positie en rotatie
  van het volledige product te bepalen.

  Eindbeslissing gebeurt nog altijd
  via contourvergelijking.
*/

function createProductMask(
  image: ImageData,
): Uint8Array {
  const {
    width,
    height,
  } = image;

  const mask =
    new Uint8Array(
      width * height,
    );

  const minX =
    Math.round(
      width * 0.05,
    );

  const maxX =
    Math.round(
      width * 0.95,
    );

  const minY =
    Math.round(
      height * 0.05,
    );

  const maxY =
    Math.round(
      height * 0.95,
    );

  for (
    let y = minY;
    y < maxY;
    y += 1
  ) {
    for (
      let x = minX;
      x < maxX;
      x += 1
    ) {
      const {
        r,
        g,
        b,
      } =
        rgbAt(
          image,
          x,
          y,
        );

      const maxColor =
        Math.max(
          r,
          g,
          b,
        );

      const minColor =
        Math.min(
          r,
          g,
          b,
        );

      const saturation =
        maxColor -
        minColor;

      const brightness =
        (
          r +
          g +
          b
        ) /
        3;

      const aluminium =
        brightness >=
          145 &&
        saturation <= 80;

      const darkPart =
        brightness <= 80;

      if (
        aluminium ||
        darkPart
      ) {
        mask[
          y *
            width +
            x
        ] = 1;
      }
    }
  }

  let cleaned =
    closeMask(
      mask,
      width,
      height,
      3,
    );

  cleaned =
    dilate(
      cleaned,
      width,
      height,
      2,
    );

  return largestConnectedComponent(
    cleaned,
    width,
    height,
  );
}

/* =========================================================
   POSE
   ========================================================= */

type Pose = {
  cx: number;
  cy: number;
  angle: number;
};

function estimatePose(
  mask: Uint8Array,
  width: number,
  height: number,
): Pose {
  let count = 0;
  let sumX = 0;
  let sumY = 0;

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      if (
        !mask[
          y *
            width +
            x
        ]
      ) {
        continue;
      }

      count += 1;
      sumX += x;
      sumY += y;
    }
  }

  if (count < 100) {
    return {
      cx: width / 2,
      cy: height / 2,
      angle: 0,
    };
  }

  const cx =
    sumX / count;

  const cy =
    sumY / count;

  let xx = 0;
  let yy = 0;
  let xy = 0;

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      if (
        !mask[
          y *
            width +
            x
        ]
      ) {
        continue;
      }

      const dx =
        x - cx;

      const dy =
        y - cy;

      xx +=
        dx * dx;

      yy +=
        dy * dy;

      xy +=
        dx * dy;
    }
  }

  const angle =
    0.5 *
    Math.atan2(
      2 * xy,
      xx - yy,
    );

  return {
    cx,
    cy,
    angle,
  };
}

/* =========================================================
   FAST REGISTRATION
   ========================================================= */

type MaskPoint = {
  x: number;
  y: number;
};

function sampleMaskPoints(
  mask: Uint8Array,
  width: number,
  height: number,
  maxPoints = 1600,
): MaskPoint[] {
  let total = 0;

  for (
    let index = 0;
    index <
    mask.length;
    index += 1
  ) {
    if (mask[index]) {
      total += 1;
    }
  }

  if (total === 0) {
    return [];
  }

  const step =
    Math.max(
      1,
      Math.floor(
        total /
          maxPoints,
      ),
    );

  const points: MaskPoint[] =
    [];

  let seen = 0;

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      if (
        !mask[
          y *
            width +
            x
        ]
      ) {
        continue;
      }

      if (
        seen % step ===
        0
      ) {
        points.push({
          x,
          y,
        });

        if (
          points.length >=
          maxPoints
        ) {
          return points;
        }
      }

      seen += 1;
    }
  }

  return points;
}

function findBestRegistration(
  currentMask: Uint8Array,
  referenceMask: Uint8Array,
  width: number,
  height: number,
): {
  currentPose: Pose;
  targetPose: Pose;
  rotation: number;
} {
  const currentPose =
    estimatePose(
      currentMask,
      width,
      height,
    );

  const referencePose =
    estimatePose(
      referenceMask,
      width,
      height,
    );

  const initialRotation =
    referencePose.angle -
    currentPose.angle;

  /*
    Referentiemasker krijgt
    tijdens de zoektocht
    wat extra tolerantie.
  */

  const referenceTolerance =
    dilate(
      referenceMask,
      width,
      height,
      12,
    );

  /*
    Slechts een steekproef
    van het productmasker
    gebruiken voor alignment.
  */

  const currentPoints =
    sampleMaskPoints(
      currentMask,
      width,
      height,
      1600,
    );

  if (
    currentPoints.length ===
    0
  ) {
    return {
      currentPose,
      targetPose:
        referencePose,
      rotation:
        initialRotation,
    };
  }

  /*
    PCA geeft al een grove hoek.
    Daarom alleen rond die hoek zoeken.
  */

  const angleOffsetsDeg =
    [
      -45,
      -30,
      -20,
      -12,
      -6,
      0,
      6,
      12,
      20,
      30,
      45,
    ];

  const angleCandidates: number[] =
    [];

  for (
    const degrees
    of angleOffsetsDeg
  ) {
    const offset =
      (
        degrees *
        Math.PI
      ) /
      180;

    angleCandidates.push(
      initialRotation +
        offset,
    );

    /*
      PCA heeft 180° ambiguïteit.
    */

    angleCandidates.push(
      initialRotation +
        Math.PI +
        offset,
    );
  }

  /*
    Centroid zorgt al voor
    grove translation alignment.

    Enkel nog lokaal verfijnen.
  */

  const translationOffsets =
    [
      -20,
      -10,
      0,
      10,
      20,
    ];

  let bestScore = -1;

  let bestRotation =
    initialRotation;

  let bestTargetPose: Pose =
    {
      ...referencePose,
    };

  for (
    const rotation
    of angleCandidates
  ) {
    const cos =
      Math.cos(
        rotation,
      );

    const sin =
      Math.sin(
        rotation,
      );

    for (
      const dx
      of translationOffsets
    ) {
      for (
        const dy
        of translationOffsets
      ) {
        const targetCx =
          referencePose.cx +
          dx;

        const targetCy =
          referencePose.cy +
          dy;

        let matched = 0;
        let valid = 0;

        for (
          const point
          of currentPoints
        ) {
          const px =
            point.x -
            currentPose.cx;

          const py =
            point.y -
            currentPose.cy;

          const transformedX =
            targetCx +
            cos * px -
            sin * py;

          const transformedY =
            targetCy +
            sin * px +
            cos * py;

          const nx =
            Math.round(
              transformedX,
            );

          const ny =
            Math.round(
              transformedY,
            );

          if (
            nx < 0 ||
            ny < 0 ||
            nx >= width ||
            ny >= height
          ) {
            continue;
          }

          valid += 1;

          if (
            referenceTolerance[
              ny *
                width +
                nx
            ]
          ) {
            matched += 1;
          }
        }

        const score =
          valid > 0
            ? matched /
              valid
            : 0;

        if (
          score >
          bestScore
        ) {
          bestScore =
            score;

          bestRotation =
            rotation;

          bestTargetPose =
            {
              cx:
                targetCx,
              cy:
                targetCy,
              angle:
                referencePose.angle,
            };
        }
      }
    }
  }

  return {
    currentPose,
    targetPose:
      bestTargetPose,
    rotation:
      bestRotation,
  };
}

/* =========================================================
   IMAGE TRANSFORM
   ========================================================= */

function transformImage(
  source: ImageData,
  sourcePose: Pose,
  targetPose: Pose,
  rotation: number,
): ImageData {
  const {
    width,
    height,
  } = source;

  const output =
    new ImageData(
      width,
      height,
    );

  /*
    Neutrale achtergrond.
  */

  for (
    let index = 0;
    index <
    output.data.length;
    index += 4
  ) {
    output.data[
      index
    ] = 238;

    output.data[
      index + 1
    ] = 238;

    output.data[
      index + 2
    ] = 238;

    output.data[
      index + 3
    ] = 255;
  }

  const cos =
    Math.cos(
      -rotation,
    );

  const sin =
    Math.sin(
      -rotation,
    );

  for (
    let y = 0;
    y < height;
    y += 1
  ) {
    for (
      let x = 0;
      x < width;
      x += 1
    ) {
      const dx =
        x -
        targetPose.cx;

      const dy =
        y -
        targetPose.cy;

      const sourceX =
        sourcePose.cx +
        cos * dx -
        sin * dy;

      const sourceY =
        sourcePose.cy +
        sin * dx +
        cos * dy;

      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >=
          width - 1 ||
        sourceY >=
          height - 1
      ) {
        continue;
      }

      const x0 =
        Math.floor(
          sourceX,
        );

      const y0 =
        Math.floor(
          sourceY,
        );

      const x1 =
        Math.min(
          width - 1,
          x0 + 1,
        );

      const y1 =
        Math.min(
          height - 1,
          y0 + 1,
        );

      const fx =
        sourceX - x0;

      const fy =
        sourceY - y0;

      const outputIndex =
        (
          y *
            width +
          x
        ) *
        4;

      for (
        let channel = 0;
        channel < 3;
        channel += 1
      ) {
        const p00 =
          source.data[
            (
              y0 *
                width +
              x0
            ) *
              4 +
              channel
          ];

        const p10 =
          source.data[
            (
              y0 *
                width +
              x1
            ) *
              4 +
              channel
          ];

        const p01 =
          source.data[
            (
              y1 *
                width +
              x0
            ) *
              4 +
              channel
          ];

        const p11 =
          source.data[
            (
              y1 *
                width +
              x1
            ) *
              4 +
              channel
          ];

        const top =
          p00 *
            (1 - fx) +
          p10 * fx;

        const bottom =
          p01 *
            (1 - fx) +
          p11 * fx;

        output.data[
          outputIndex +
            channel
        ] =
          Math.round(
            top *
              (1 - fy) +
              bottom *
                fy,
          );
      }

      output.data[
        outputIndex + 3
      ] = 255;
    }
  }

  return output;
}

/* =========================================================
   OVERLAY
   ========================================================= */

function createOverlayUrl(
  current: ImageData,
  referenceEdges: Uint8Array,
  currentEdges: Uint8Array,
  dilatedReference: Uint8Array,
  dilatedCurrent: Uint8Array,
): string {
  const canvas =
    document.createElement(
      "canvas",
    );

  canvas.width =
    current.width;

  canvas.height =
    current.height;

  const context =
    canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Canvas unavailable",
    );
  }

  context.putImageData(
    current,
    0,
    0,
  );

  const overlay =
    context.createImageData(
      current.width,
      current.height,
    );

  for (
    let index = 0;
    index <
    referenceEdges.length;
    index += 1
  ) {
    const pixel =
      index * 4;

    /*
      GROEN:
      verwachte contour gevonden
    */

    if (
      referenceEdges[index] &&
      dilatedCurrent[index]
    ) {
      overlay.data[
        pixel
      ] = 34;

      overlay.data[
        pixel + 1
      ] = 197;

      overlay.data[
        pixel + 2
      ] = 94;

      overlay.data[
        pixel + 3
      ] = 235;
    }

    /*
      GEEL:
      verwachte contour ontbreekt
    */

    if (
      referenceEdges[index] &&
      !dilatedCurrent[index]
    ) {
      overlay.data[
        pixel
      ] = 245;

      overlay.data[
        pixel + 1
      ] = 158;

      overlay.data[
        pixel + 2
      ] = 11;

      overlay.data[
        pixel + 3
      ] = 245;
    }

    /*
      ROOD:
      onverwachte contour
    */

    if (
      currentEdges[index] &&
      !dilatedReference[index]
    ) {
      overlay.data[
        pixel
      ] = 220;

      overlay.data[
        pixel + 1
      ] = 38;

      overlay.data[
        pixel + 2
      ] = 38;

      overlay.data[
        pixel + 3
      ] = 245;
    }
  }

  const overlayCanvas =
    document.createElement(
      "canvas",
    );

  overlayCanvas.width =
    current.width;

  overlayCanvas.height =
    current.height;

  overlayCanvas
    .getContext("2d")
    ?.putImageData(
      overlay,
      0,
      0,
    );

  context.globalAlpha =
    0.92;

  context.drawImage(
    overlayCanvas,
    0,
    0,
  );

  return canvas.toDataURL(
    "image/jpeg",
    0.94,
  );
}

/* =========================================================
   MAIN INSPECTION
   ========================================================= */

export function inspectAgainstReference(
  product: ProductId,
  current: ImageData,
  reference: ImageData,
): OverlayInspectionResult {
  const width =
    NORMALIZED_WIDTH;

  const height =
    NORMALIZED_HEIGHT;

  /*
    1. Masker maken voor globale
       productregistratie
  */

  const referenceMask =
    createProductMask(
      reference,
    );

  const currentMask =
    createProductMask(
      current,
    );

  /*
    2. Globale positie + rotatie
       zoeken
  */

  const registration =
    findBestRegistration(
      currentMask,
      referenceMask,
      width,
      height,
    );

  /*
    3. Hele huidige foto
       uitlijnen naar referentie
  */

  const alignedImage =
    transformImage(
      current,
      registration.currentPose,
      registration.targetPose,
      registration.rotation,
    );

  /*
    4. Pas nu contours maken
  */

  const referenceEdges =
    createEdgeMap(
      reference,
    );

  const currentEdges =
    createEdgeMap(
      alignedImage,
    );

  /*
    5. Tolerantieband
  */

  const dilatedReference =
    dilate(
      referenceEdges,
      width,
      height,
      CONTOUR_TOLERANCE_PX,
    );

  const dilatedCurrent =
    dilate(
      currentEdges,
      width,
      height,
      CONTOUR_TOLERANCE_PX,
    );

  let referenceMatched = 0;
  let currentMatched = 0;

  const referenceEdgePixels =
    countOnes(
      referenceEdges,
    );

  const currentEdgePixels =
    countOnes(
      currentEdges,
    );

  for (
    let index = 0;
    index <
    referenceEdges.length;
    index += 1
  ) {
    if (
      referenceEdges[index] &&
      dilatedCurrent[index]
    ) {
      referenceMatched += 1;
    }

    if (
      currentEdges[index] &&
      dilatedReference[index]
    ) {
      currentMatched += 1;
    }
  }

  /*
    6. Scores
  */

  const expectedContourFound =
    referenceEdgePixels > 0
      ? referenceMatched /
        referenceEdgePixels
      : 0;

  const currentContourInsideTolerance =
    currentEdgePixels > 0
      ? currentMatched /
        currentEdgePixels
      : 0;

  const score =
    Math.min(
      expectedContourFound,
      currentContourInsideTolerance,
    );

  /*
    7. OK / NOK
  */

  const status =
    expectedContourFound >=
      EXPECTED_CONTOUR_THRESHOLD &&
    currentContourInsideTolerance >=
      PLACEMENT_CONTOUR_THRESHOLD
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

    expectedThreshold:
      EXPECTED_CONTOUR_THRESHOLD,

    placementThreshold:
      PLACEMENT_CONTOUR_THRESHOLD,

    overlayUrl:
      createOverlayUrl(
        alignedImage,
        referenceEdges,
        currentEdges,
        dilatedReference,
        dilatedCurrent,
      ),
  };
}

/* =========================================================
   REFERENCES
   ========================================================= */

export function saveReference(
  product: ProductId,
  normalizedImageUrl: string,
): void {
  const value:
    StoredReference = {
    product,
    imageUrl:
      normalizedImageUrl,
    createdAt:
      Date.now(),
  };

  localStorage.setItem(
    REFERENCE_KEYS[
      product
    ],
    JSON.stringify(
      value,
    ),
  );
}

export function loadReference(
  product: ProductId,
): StoredReference | null {
  try {
    const raw =
      localStorage.getItem(
        REFERENCE_KEYS[
          product
        ],
      );

    if (!raw) {
      return null;
    }

    const parsed =
      JSON.parse(
        raw,
      ) as StoredReference;

    if (
      !parsed.imageUrl ||
      parsed.product !==
        product
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function deleteReference(
  product: ProductId,
): void {
  localStorage.removeItem(
    REFERENCE_KEYS[
      product
    ],
  );
}
