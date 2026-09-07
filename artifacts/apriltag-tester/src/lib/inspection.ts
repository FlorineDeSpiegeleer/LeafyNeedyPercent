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

export type WheelCheck = {
  id:
    | "wheel-tl"
    | "wheel-tr"
    | "wheel-bl"
    | "wheel-br";

  label: string;

  score: number;

  threshold: number;

  status:
    | "ok"
    | "nok";
};

export type OverlayInspectionResult = {
  status:
    | "ok"
    | "nok";

  product: ProductId;

  score: number;

  expectedContourFound: number;

  currentContourInsideTolerance: number;

  referenceEdgePixels: number;

  currentEdgePixels: number;

  expectedThreshold: number;

  placementThreshold: number;

  wheelChecks: WheelCheck[];

  overlayUrl: string;
};

/* =========================================================
   SETTINGS
   ========================================================= */

/*
 * Physical AprilTag reference rectangle:
 * 795 mm × 595 mm
 *
 * We also use these numbers as normalized pixel dimensions.
 */
export const NORMALIZED_WIDTH =
  795;

export const NORMALIZED_HEIGHT =
  595;

/*
 * Global shape thresholds.
 *
 * Wheels are excluded from this global comparison.
 */
export const EXPECTED_CONTOUR_THRESHOLD =
  0.72;

export const PLACEMENT_CONTOUR_THRESHOLD =
  0.72;

/*
 * Each wheel is checked separately.
 *
 * Deliberately less strict because a swivel wheel
 * can rotate while still being correctly mounted.
 */
export const WHEEL_THRESHOLD =
  0.45;

/*
 * Global profile / handle tolerance.
 */
export const CONTOUR_TOLERANCE_PX =
  18;

/*
 * Wheel tolerance.
 */
export const WHEEL_TOLERANCE_PX =
  12;

/*
 * Saved references in browser localStorage.
 */
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
   APRILTAG HOMOGRAPHY
   ========================================================= */

function centerOf(
  detection: Detection,
): Point {
  if (detection.center) {
    return detection.center;
  }

  return detection.corners.reduce(
    (
      result,
      point,
    ) => ({
      x:
        result.x +
        point.x /
          detection.corners.length,

      y:
        result.y +
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
  const n =
    values.length;

  const augmented =
    matrix.map(
      (
        row,
        index,
      ) => [
        ...row,
        values[index],
      ],
    );

  for (
    let column = 0;
    column < n;
    column += 1
  ) {
    let pivot =
      column;

    for (
      let row =
        column + 1;
      row < n;
      row += 1
    ) {
      if (
        Math.abs(
          augmented[row][column],
        ) >
        Math.abs(
          augmented[pivot][column],
        )
      ) {
        pivot =
          row;
      }
    }

    if (
      Math.abs(
        augmented[pivot][column],
      ) <
      1e-10
    ) {
      return null;
    }

    [
      augmented[column],
      augmented[pivot],
    ] = [
      augmented[pivot],
      augmented[column],
    ];

    const divisor =
      augmented[column][column];

    for (
      let index =
        column;
      index <= n;
      index += 1
    ) {
      augmented[column][index] /=
        divisor;
    }

    for (
      let row = 0;
      row < n;
      row += 1
    ) {
      if (
        row ===
        column
      ) {
        continue;
      }

      const factor =
        augmented[row][column];

      for (
        let index =
          column;
        index <= n;
        index += 1
      ) {
        augmented[row][index] -=
          factor *
          augmented[column][index];
      }
    }
  }

  return augmented.map(
    (row) =>
      row[n],
  );
}

function homographyFromFourPoints(
  from: Point[],
  to: Point[],
): number[] | null {
  const matrix: number[][] =
    [];

  const values: number[] =
    [];

  from.forEach(
    (
      point,
      index,
    ) => {
      const target =
        to[index];

      matrix.push([
        point.x,
        point.y,
        1,

        0,
        0,
        0,

        -target.x *
          point.x,

        -target.x *
          point.y,
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

        -target.y *
          point.x,

        -target.y *
          point.y,
      ]);

      values.push(
        target.y,
      );
    },
  );

  const result =
    solveLinearSystem(
      matrix,
      values,
    );

  if (!result) {
    return null;
  }

  return [
    ...result,
    1,
  ];
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
   * Tag layout:
   *
   * 0 -------- 1
   * |          |
   * |          |
   * 2 -------- 3
   */

  const sourcePoints =
    [
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
          Boolean(
            detection,
          ),
      )
      .map(
        centerOf,
      );

  if (
    sourcePoints.length !==
    4
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
        homography[6] *
          x +
        homography[7] *
          y +
        homography[8];

      const sourceX =
        (
          homography[0] *
            x +
          homography[1] *
            y +
          homography[2]
        ) /
        denominator;

      const sourceY =
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
        !Number.isFinite(
          sourceX,
        ) ||
        !Number.isFinite(
          sourceY,
        ) ||
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >=
          source.width -
            1 ||
        sourceY >=
          source.height -
            1
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
        Math.floor(
          sourceX,
        );

      const y0 =
        Math.floor(
          sourceY,
        );

      const x1 =
        Math.min(
          source.width -
            1,

          x0 + 1,
        );

      const y1 =
        Math.min(
          source.height -
            1,

          y0 + 1,
        );

      const dx =
        sourceX -
        x0;

      const dy =
        sourceY -
        y0;

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
          p10 *
            dx;

        const bottom =
          p01 *
            (1 - dx) +
          p11 *
            dx;

        output.data[
          outputIndex +
            channel
        ] =
          Math.round(
            top *
              (1 - dy) +
            bottom *
              dy,
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
  quality =
    0.94,
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
    canvas.getContext(
      "2d",
    );

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
        () =>
          resolve();

      image.onerror =
        () =>
          reject(
            new Error(
              "Reference image could not be loaded.",
            ),
          );

      image.src =
        url;
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
    canvas.getContext(
      "2d",
    );

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
    image.data[
      index
    ] *
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
      width *
        height,
    );

  const blurred =
    new Float32Array(
      width *
        height,
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
        y *
          width +
        x
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
      let sum =
        0;

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
                y +
                oy
              ) *
                width +
              (
                x +
                ox
              )
            ];
        }
      }

      blurred[
        y *
          width +
        x
      ] =
        sum /
        9;
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
    blurredGray(
      image,
    );

  const edges =
    new Uint8Array(
      width *
        height,
    );

  const EDGE_THRESHOLD =
    28;

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
            y -
              1
          ) *
            width +
          x
        ];

      const bottom =
        gray[
          (
            y +
              1
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

  const marginX =
    Math.round(
      width *
        0.045,
    );

  const marginY =
    Math.round(
      height *
        0.045,
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
        x <
          marginX ||
        y <
          marginY ||
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
            ox *
              ox +
            oy *
              oy >
            radius *
              radius
          ) {
            continue;
          }

          const nx =
            x +
            ox;

          const ny =
            y +
            oy;

          if (
            nx < 0 ||
            ny < 0 ||
            nx >=
              width ||
            ny >=
              height
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
    let y =
      radius;
    y <
      height -
        radius;
    y += 1
  ) {
    for (
      let x =
        radius;
      x <
        width -
          radius;
      x += 1
    ) {
      let keep =
        true;

      for (
        let oy =
          -radius;
        oy <=
          radius &&
        keep;
        oy += 1
      ) {
        for (
          let ox =
            -radius;
          ox <=
            radius;
          ox += 1
        ) {
          if (
            ox *
              ox +
            oy *
              oy >
            radius *
              radius
          ) {
            continue;
          }

          if (
            !source[
              (
                y +
                oy
              ) *
                width +
              (
                x +
                ox
              )
            ]
          ) {
            keep =
              false;

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
  let count =
    0;

  for (
    let index = 0;
    index <
      map.length;
    index += 1
  ) {
    if (
      map[index]
    ) {
      count +=
        1;
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
    r:
      image.data[
        index
      ],

    g:
      image.data[
        index +
          1
      ],

    b:
      image.data[
        index +
          2
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
      width *
        height,
    );

  const queueY =
    new Int32Array(
      width *
        height,
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

      let head =
        0;

      let tail =
        0;

      queueX[
        tail
      ] =
        startX;

      queueY[
        tail
      ] =
        startY;

      tail +=
        1;

      visited[
        startIndex
      ] = 1;

      const pixels: number[] =
        [];

      while (
        head <
        tail
      ) {
        const x =
          queueX[
            head
          ];

        const y =
          queueY[
            head
          ];

        head +=
          1;

        pixels.push(
          y *
            width +
          x,
        );

        for (
          let oy =
            -1;
          oy <= 1;
          oy += 1
        ) {
          for (
            let ox =
              -1;
            ox <= 1;
            ox += 1
          ) {
            if (
              ox ===
                0 &&
              oy ===
                0
            ) {
              continue;
            }

            const nx =
              x +
              ox;

            const ny =
              y +
              oy;

            if (
              nx < 0 ||
              ny < 0 ||
              nx >=
                width ||
              ny >=
                height
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

            queueX[
              tail
            ] =
              nx;

            queueY[
              tail
            ] =
              ny;

            tail +=
              1;
          }
        }
      }

      if (
        pixels.length >
        best.length
      ) {
        best =
          pixels;
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
    output[
      index
    ] = 1;
  }

  return output;
}

/*
 * Used only for global alignment.
 *
 * Aluminium + dark parts are detected so that
 * the whole product can be located.
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
      width *
        height,
    );

  const minX =
    Math.round(
      width *
        0.05,
    );

  const maxX =
    Math.round(
      width *
        0.95,
    );

  const minY =
    Math.round(
      height *
        0.05,
    );

  const maxY =
    Math.round(
      height *
        0.95,
    );

  for (
    let y =
      minY;
    y <
      maxY;
    y += 1
  ) {
    for (
      let x =
        minX;
      x <
        maxX;
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

      const maximum =
        Math.max(
          r,
          g,
          b,
        );

      const minimum =
        Math.min(
          r,
          g,
          b,
        );

      const saturation =
        maximum -
        minimum;

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
        saturation <=
          80;

      const darkPart =
        brightness <=
        85;

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
   DARK WHEEL MASK
   ========================================================= */

function createDarkMask(
  image: ImageData,
): Uint8Array {
  const {
    width,
    height,
  } = image;

  const mask =
    new Uint8Array(
      width *
        height,
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
      const index =
        (
          y *
            width +
          x
        ) *
        4;

      const r =
        image.data[
          index
        ];

      const g =
        image.data[
          index +
            1
        ];

      const b =
        image.data[
          index +
            2
        ];

      const brightness =
        (
          r +
          g +
          b
        ) /
        3;

      if (
        brightness <
        95
      ) {
        mask[
          y *
            width +
          x
        ] = 1;
      }
    }
  }

  return mask;
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
  let count =
    0;

  let sumX =
    0;

  let sumY =
    0;

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

      count +=
        1;

      sumX +=
        x;

      sumY +=
        y;
    }
  }

  if (
    count <
    100
  ) {
    return {
      cx:
        width /
        2,

      cy:
        height /
        2,

      angle:
        0,
    };
  }

  const cx =
    sumX /
    count;

  const cy =
    sumY /
    count;

  let xx =
    0;

  let yy =
    0;

  let xy =
    0;

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
        x -
        cx;

      const dy =
        y -
        cy;

      xx +=
        dx *
        dx;

      yy +=
        dy *
        dy;

      xy +=
        dx *
        dy;
    }
  }

  const angle =
    0.5 *
    Math.atan2(
      2 *
        xy,

      xx -
        yy,
    );

  return {
    cx,
    cy,
    angle,
  };
}

/* =========================================================
   FAST GLOBAL ALIGNMENT
   ========================================================= */

type MaskPoint = {
  x: number;

  y: number;
};

function sampleMaskPoints(
  mask: Uint8Array,
  width: number,
  height: number,
  maxPoints =
    1400,
): MaskPoint[] {
  let total =
    0;

  for (
    let index = 0;
    index <
      mask.length;
    index += 1
  ) {
    if (
      mask[
        index
      ]
    ) {
      total +=
        1;
    }
  }

  if (
    total ===
    0
  ) {
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

  let seen =
    0;

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
        seen %
          step ===
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

      seen +=
        1;
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

  const referenceTolerance =
    dilate(
      referenceMask,
      width,
      height,
      14,
    );

  const points =
    sampleMaskPoints(
      currentMask,
      width,
      height,
      1400,
    );

  if (
    points.length ===
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

  const angleOffsets =
    [
      -35,
      -20,
      -10,
      -5,
      0,
      5,
      10,
      20,
      35,
    ];

  const candidateAngles: number[] =
    [];

  for (
    const degrees
    of angleOffsets
  ) {
    const offset =
      degrees *
      Math.PI /
      180;

    candidateAngles.push(
      initialRotation +
        offset,
    );

    candidateAngles.push(
      initialRotation +
        Math.PI +
        offset,
    );
  }

  const translations =
    [
      -16,
      -8,
      0,
      8,
      16,
    ];

  let bestScore =
    -1;

  let bestRotation =
    initialRotation;

  let bestTargetPose: Pose =
    {
      ...referencePose,
    };

  for (
    const rotation
    of candidateAngles
  ) {
    const cosine =
      Math.cos(
        rotation,
      );

    const sine =
      Math.sin(
        rotation,
      );

    for (
      const dx
      of translations
    ) {
      for (
        const dy
        of translations
      ) {
        const targetX =
          referencePose.cx +
          dx;

        const targetY =
          referencePose.cy +
          dy;

        let valid =
          0;

        let matched =
          0;

        for (
          const point
          of points
        ) {
          const px =
            point.x -
            currentPose.cx;

          const py =
            point.y -
            currentPose.cy;

          const transformedX =
            targetX +
            cosine *
              px -
            sine *
              py;

          const transformedY =
            targetY +
            sine *
              px +
            cosine *
              py;

          const x =
            Math.round(
              transformedX,
            );

          const y =
            Math.round(
              transformedY,
            );

          if (
            x < 0 ||
            y < 0 ||
            x >=
              width ||
            y >=
              height
          ) {
            continue;
          }

          valid +=
            1;

          if (
            referenceTolerance[
              y *
                width +
              x
            ]
          ) {
            matched +=
              1;
          }
        }

        const score =
          valid >
          0
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
                targetX,

              cy:
                targetY,

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
   ALIGN CURRENT IMAGE TO REFERENCE
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
      index +
        1
    ] = 238;

    output.data[
      index +
        2
    ] = 238;

    output.data[
      index +
        3
    ] = 255;
  }

  const cosine =
    Math.cos(
      -rotation,
    );

  const sine =
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
        cosine *
          dx -
        sine *
          dy;

      const sourceY =
        sourcePose.cy +
        sine *
          dx +
        cosine *
          dy;

      if (
        sourceX < 0 ||
        sourceY < 0 ||
        sourceX >=
          width -
            1 ||
        sourceY >=
          height -
            1
      ) {
        continue;
      }

      const roundedX =
        Math.round(
          sourceX,
        );

      const roundedY =
        Math.round(
          sourceY,
        );

      const sourceIndex =
        (
          roundedY *
            width +
          roundedX
        ) *
        4;

      const outputIndex =
        (
          y *
            width +
          x
        ) *
        4;

      output.data[
        outputIndex
      ] =
        source.data[
          sourceIndex
        ];

      output.data[
        outputIndex +
          1
      ] =
        source.data[
          sourceIndex +
            1
        ];

      output.data[
        outputIndex +
          2
      ] =
        source.data[
          sourceIndex +
            2
        ];

      output.data[
        outputIndex +
          3
      ] = 255;
    }
  }

  return output;
}

/* =========================================================
   BOUNDING BOX
   ========================================================= */

type BoundingBox = {
  x1: number;

  y1: number;

  x2: number;

  y2: number;

  width: number;

  height: number;
};

function getBoundingBox(
  mask: Uint8Array,
  width: number,
  height: number,
): BoundingBox {
  let minimumX =
    width;

  let minimumY =
    height;

  let maximumX =
    0;

  let maximumY =
    0;

  let found =
    false;

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

      found =
        true;

      minimumX =
        Math.min(
          minimumX,
          x,
        );

      minimumY =
        Math.min(
          minimumY,
          y,
        );

      maximumX =
        Math.max(
          maximumX,
          x,
        );

      maximumY =
        Math.max(
          maximumY,
          y,
        );
    }
  }

  if (!found) {
    return {
      x1:
        width *
        0.2,

      y1:
        height *
        0.2,

      x2:
        width *
        0.8,

      y2:
        height *
        0.8,

      width:
        width *
        0.6,

      height:
        height *
        0.6,
    };
  }

  return {
    x1:
      minimumX,

    y1:
      minimumY,

    x2:
      maximumX,

    y2:
      maximumY,

    width:
      maximumX -
      minimumX,

    height:
      maximumY -
      minimumY,
  };
}

/* =========================================================
   WHEEL REGIONS
   ========================================================= */

type Region = {
  x1: number;

  y1: number;

  x2: number;

  y2: number;
};

function createWheelRegions(
  referenceMask: Uint8Array,
  width: number,
  height: number,
): Record<
  WheelCheck["id"],
  Region
> {
  const box =
    getBoundingBox(
      referenceMask,
      width,
      height,
    );

  /*
   * Narrower than previous version.
   *
   * Width: 22% of product width.
   * Height stays larger because wheel/bracket
   * may swivel vertically in image.
   */
  const regionWidth =
    Math.max(
      55,

      box.width *
        0.22,
    );

  const regionHeight =
    Math.max(
      75,

      box.height *
        0.32,
    );

  return {
    "wheel-tl": {
      x1:
        box.x1 -
        regionWidth *
          0.10,

      y1:
        box.y1 -
        regionHeight *
          0.15,

      x2:
        box.x1 +
        regionWidth,

      y2:
        box.y1 +
        regionHeight,
    },

    "wheel-tr": {
      x1:
        box.x2 -
        regionWidth,

      y1:
        box.y1 -
        regionHeight *
          0.15,

      x2:
        box.x2 +
        regionWidth *
          0.10,

      y2:
        box.y1 +
        regionHeight,
    },

    "wheel-bl": {
      x1:
        box.x1 -
        regionWidth *
          0.10,

      y1:
        box.y2 -
        regionHeight,

      x2:
        box.x1 +
        regionWidth,

      y2:
        box.y2 +
        regionHeight *
          0.15,
    },

    "wheel-br": {
      x1:
        box.x2 -
        regionWidth,

      y1:
        box.y2 -
        regionHeight,

      x2:
        box.x2 +
        regionWidth *
          0.10,

      y2:
        box.y2 +
        regionHeight *
          0.15,
    },
  };
}

/* =========================================================
   REMOVE WHEELS FROM GLOBAL CONTOUR
   ========================================================= */

function removeRegionsFromMask(
  source: Uint8Array,
  width: number,
  height: number,
  regions: Region[],
): Uint8Array {
  const output =
    source.slice();

  for (
    const region
    of regions
  ) {
    const x1 =
      Math.max(
        0,

        Math.floor(
          region.x1,
        ),
      );

    const y1 =
      Math.max(
        0,

        Math.floor(
          region.y1,
        ),
      );

    const x2 =
      Math.min(
        width -
          1,

        Math.ceil(
          region.x2,
        ),
      );

    const y2 =
      Math.min(
        height -
          1,

        Math.ceil(
          region.y2,
        ),
      );

    for (
      let y =
        y1;
      y <=
        y2;
      y += 1
    ) {
      for (
        let x =
          x1;
        x <=
          x2;
        x += 1
      ) {
        output[
          y *
            width +
          x
        ] = 0;
      }
    }
  }

  return output;
}

/* =========================================================
   WHEEL SCORING
   ========================================================= */

function scoreWheelRegion(
  referenceDark:
    Uint8Array,

  currentDark:
    Uint8Array,

  width:
    number,

  height:
    number,

  region:
    Region,
): number {
  const currentTolerance =
    dilate(
      currentDark,
      width,
      height,
      WHEEL_TOLERANCE_PX,
    );

  let referencePixels =
    0;

  let matchedPixels =
    0;

  const x1 =
    Math.max(
      0,

      Math.floor(
        region.x1,
      ),
    );

  const y1 =
    Math.max(
      0,

      Math.floor(
        region.y1,
      ),
    );

  const x2 =
    Math.min(
      width -
        1,

      Math.ceil(
        region.x2,
      ),
    );

  const y2 =
    Math.min(
      height -
        1,

      Math.ceil(
        region.y2,
      ),
    );

  for (
    let y =
      y1;
    y <=
      y2;
    y += 1
  ) {
    for (
      let x =
        x1;
      x <=
        x2;
      x += 1
    ) {
      const index =
        y *
          width +
        x;

      if (
        !referenceDark[
          index
        ]
      ) {
        continue;
      }

      referencePixels +=
        1;

      if (
        currentTolerance[
          index
        ]
      ) {
        matchedPixels +=
          1;
      }
    }
  }

  if (
    referencePixels <
    20
  ) {
    return 1;
  }

  return (
    matchedPixels /
    referencePixels
  );
}

function runWheelChecks(
  referenceImage:
    ImageData,

  currentImage:
    ImageData,

  referenceProductMask:
    Uint8Array,
): WheelCheck[] {
  const width =
    referenceImage.width;

  const height =
    referenceImage.height;

  const referenceDark =
    createDarkMask(
      referenceImage,
    );

  const currentDark =
    createDarkMask(
      currentImage,
    );

  const regions =
    createWheelRegions(
      referenceProductMask,
      width,
      height,
    );

  const definitions: Array<{
    id:
      WheelCheck["id"];

    label:
      string;
  }> = [
    {
      id:
        "wheel-tl",

      label:
        "Wiel linksboven",
    },

    {
      id:
        "wheel-tr",

      label:
        "Wiel rechtsboven",
    },

    {
      id:
        "wheel-bl",

      label:
        "Wiel linksonder",
    },

    {
      id:
        "wheel-br",

      label:
        "Wiel rechtsonder",
    },
  ];

  return definitions.map(
    ({
      id,
      label,
    }) => {
      const score =
        scoreWheelRegion(
          referenceDark,
          currentDark,
          width,
          height,
          regions[
            id
          ],
        );

      return {
        id,

        label,

        score,

        threshold:
          WHEEL_THRESHOLD,

        status:
          score >=
          WHEEL_THRESHOLD
            ? "ok"
            : "nok",
      };
    },
  );
}

/* =========================================================
   OVERLAY
   ========================================================= */

function createOverlayUrl(
  current:
    ImageData,

  referenceEdges:
    Uint8Array,

  currentEdges:
    Uint8Array,

  dilatedReference:
    Uint8Array,

  dilatedCurrent:
    Uint8Array,

  wheelChecks:
    WheelCheck[],

  referenceMask:
    Uint8Array,
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
    canvas.getContext(
      "2d",
    );

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
      index *
      4;

    /*
     * GREEN
     */
    if (
      referenceEdges[
        index
      ] &&
      dilatedCurrent[
        index
      ]
    ) {
      overlay.data[
        pixel
      ] = 34;

      overlay.data[
        pixel +
          1
      ] = 197;

      overlay.data[
        pixel +
          2
      ] = 94;

      overlay.data[
        pixel +
          3
      ] = 220;
    }

    /*
     * YELLOW
     */
    if (
      referenceEdges[
        index
      ] &&
      !dilatedCurrent[
        index
      ]
    ) {
      overlay.data[
        pixel
      ] = 245;

      overlay.data[
        pixel +
          1
      ] = 158;

      overlay.data[
        pixel +
          2
      ] = 11;

      overlay.data[
        pixel +
          3
      ] = 235;
    }

    /*
     * RED
     */
    if (
      currentEdges[
        index
      ] &&
      !dilatedReference[
        index
      ]
    ) {
      overlay.data[
        pixel
      ] = 220;

      overlay.data[
        pixel +
          1
      ] = 38;

      overlay.data[
        pixel +
          2
      ] = 38;

      overlay.data[
        pixel +
          3
      ] = 235;
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

  const overlayContext =
    overlayCanvas.getContext(
      "2d",
    );

  overlayContext?.putImageData(
    overlay,
    0,
    0,
  );

  context.drawImage(
    overlayCanvas,
    0,
    0,
  );

  /*
   * Draw wheel quality gates.
   */
  const wheelRegions =
    createWheelRegions(
      referenceMask,
      current.width,
      current.height,
    );

  context.lineWidth =
    3;

  context.font =
    "bold 13px Arial";

  for (
    const check
    of wheelChecks
  ) {
    const region =
      wheelRegions[
        check.id
      ];

    if (
      check.status ===
      "ok"
    ) {
      context.strokeStyle =
        "#22c55e";

      context.fillStyle =
        "#22c55e";
    } else {
      context.strokeStyle =
        "#dc2626";

      context.fillStyle =
        "#dc2626";
    }

    context.strokeRect(
      region.x1,
      region.y1,

      region.x2 -
        region.x1,

      region.y2 -
        region.y1,
    );

    context.fillText(
      `${Math.round(
        check.score *
          100,
      )}%`,

      region.x1 +
        4,

      region.y1 +
        16,
    );
  }

  return canvas.toDataURL(
    "image/jpeg",
    0.94,
  );
}

/* =========================================================
   MAIN INSPECTION
   ========================================================= */

export function inspectAgainstReference(
  product:
    ProductId,

  current:
    ImageData,

  reference:
    ImageData,
): OverlayInspectionResult {
  const width =
    NORMALIZED_WIDTH;

  const height =
    NORMALIZED_HEIGHT;

  /*
   * 1. Locate complete product.
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
   * 2. Globally align current product
   *    with reference.
   */
  const registration =
    findBestRegistration(
      currentMask,
      referenceMask,
      width,
      height,
    );

  const alignedImage =
    transformImage(
      current,

      registration.currentPose,

      registration.targetPose,

      registration.rotation,
    );

  /*
   * 3. Determine wheel regions.
   */
  const wheelRegions =
    createWheelRegions(
      referenceMask,
      width,
      height,
    );

  const wheelRegionList =
    [
      wheelRegions[
        "wheel-tl"
      ],

      wheelRegions[
        "wheel-tr"
      ],

      wheelRegions[
        "wheel-bl"
      ],

      wheelRegions[
        "wheel-br"
      ],
    ];

  /*
   * 4. Build normal edge maps.
   */
  const rawReferenceEdges =
    createEdgeMap(
      reference,
    );

  const rawCurrentEdges =
    createEdgeMap(
      alignedImage,
    );

  /*
   * 5. IMPORTANT:
   *
   * Wheel regions are removed from GLOBAL comparison.
   *
   * Their black contour no longer lowers the global score.
   */
  const referenceEdges =
    removeRegionsFromMask(
      rawReferenceEdges,
      width,
      height,
      wheelRegionList,
    );

  const currentEdges =
    removeRegionsFromMask(
      rawCurrentEdges,
      width,
      height,
      wheelRegionList,
    );

  /*
   * 6. Global contour tolerance.
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

  let referenceMatched =
    0;

  let currentMatched =
    0;

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
      referenceEdges[
        index
      ] &&
      dilatedCurrent[
        index
      ]
    ) {
      referenceMatched +=
        1;
    }

    if (
      currentEdges[
        index
      ] &&
      dilatedReference[
        index
      ]
    ) {
      currentMatched +=
        1;
    }
  }

  const expectedContourFound =
    referenceEdgePixels >
    0
      ? referenceMatched /
        referenceEdgePixels
      : 0;

  const currentContourInsideTolerance =
    currentEdgePixels >
    0
      ? currentMatched /
        currentEdgePixels
      : 0;

  /*
   * 7. Check wheels separately.
   */
  const wheelChecks =
    runWheelChecks(
      reference,
      alignedImage,
      referenceMask,
    );

  const allWheelsOK =
    wheelChecks.every(
      (check) =>
        check.status ===
        "ok",
    );

  /*
   * 8. Global score.
   */
  const globalScore =
    Math.min(
      expectedContourFound,
      currentContourInsideTolerance,
    );

  const weakestWheel =
    wheelChecks.length >
    0
      ? Math.min(
          ...wheelChecks.map(
            (check) =>
              check.score,
          ),
        )
      : 1;

  /*
   * Display score still includes weakest quality gate.
   */
  const score =
    Math.min(
      globalScore,
      weakestWheel,
    );

  /*
   * 9. Final decision:
   *
   * - profiles / handle globally correct
   * - all four wheels individually acceptable
   */
  const status =
    expectedContourFound >=
      EXPECTED_CONTOUR_THRESHOLD &&

    currentContourInsideTolerance >=
      PLACEMENT_CONTOUR_THRESHOLD &&

    allWheelsOK
      ? "ok"
      : "nok";

  /*
   * 10. Overlay.
   */
  const overlayUrl =
    createOverlayUrl(
      alignedImage,
      referenceEdges,
      currentEdges,
      dilatedReference,
      dilatedCurrent,
      wheelChecks,
      referenceMask,
    );

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

    wheelChecks,

    overlayUrl,
  };
}

/* =========================================================
   REFERENCES
   ========================================================= */

export function saveReference(
  product:
    ProductId,

  normalizedImageUrl:
    string,
): void {
  const value: StoredReference =
    {
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
  product:
    ProductId,
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
  product:
    ProductId,
): void {
  localStorage.removeItem(
    REFERENCE_KEYS[
      product
    ],
  );
}
