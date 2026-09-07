import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";

import {
  AlertTriangle,
  Camera,
  Check,
  ChevronRight,
  Eye,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";

import {
  EXPECTED_CONTOUR_THRESHOLD,
  PLACEMENT_CONTOUR_THRESHOLD,
  NORMALIZED_HEIGHT,
  NORMALIZED_WIDTH,
  deleteReference,
  imageDataToUrl,
  imageUrlToImageData,
  inspectAgainstReference,
  loadReference,
  normalizeImage,
  saveReference,
  type Detection,
  type OverlayInspectionResult,
  type ProductId,
  type StoredReference,
} from "@/lib/inspection";

type CameraState = "idle" | "opening" | "ready" | "error";
type DetectorState = "loading" | "ready" | "error";
type PageMode = "setup" | "control";
type CaptureMode = "reference" | "inspection";

type Capture = {
  url: string;
  width: number;
  height: number;
};

const EXPECTED_IDS = [0, 1, 2, 3];
const ADMIN_PIN = "9999";

function productLabel(product: ProductId) {
  return product === "product1" ? "Product 1" : "Product 2";
}

function productDescription(product: ProductId) {
  return product === "product1"
    ? "Profielen · 4 wielen · handvat"
    : "Profielen · 4 wielen · zonder handvat";
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const selectedProductRef = useRef<ProductId>("product1");
  const captureModeRef = useRef<CaptureMode>("inspection");

  const setupRequested = useMemo(
    () => new URLSearchParams(window.location.search).get("setup") === "1",
    [],
  );

  const embedMode = useMemo(
    () => new URLSearchParams(window.location.search).get("embed") === "1",
    [],
  );

  const forcedProduct = useMemo<ProductId>(() => {
    const value = new URLSearchParams(window.location.search).get("product");
    return value === "product2" ? "product2" : "product1";
  }, []);

  const [pageMode, setPageMode] = useState<PageMode>(
    setupRequested ? "setup" : "control",
  );

  const [adminUnlocked, setAdminUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState(false);

  const [selectedProduct, setSelectedProduct] =
    useState<ProductId>(embedMode ? forcedProduct : "product1");

  const [cameraState, setCameraState] =
    useState<CameraState>("idle");

  const [detectorState, setDetectorState] =
    useState<DetectorState>("loading");

  const [capture, setCapture] = useState<Capture | null>(null);
  const [detections, setDetections] = useState<Detection[] | null>(null);

  const [normalizedUrl, setNormalizedUrl] =
    useState<string | null>(null);

  const [result, setResult] =
    useState<OverlayInspectionResult | null>(null);

  const [references, setReferences] =
    useState<Partial<Record<ProductId, StoredReference>>>({});

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState("");


  useEffect(() => {
    if (!embedMode) return;

    selectedProductRef.current = forcedProduct;
    setSelectedProduct(forcedProduct);
  }, [embedMode, forcedProduct]);

  useEffect(() => {
    if (!embedMode || !result) return;

    if (window.parent !== window) {
      window.parent.postMessage(
        {
          type: "sirris-final-qc-result",
          product: result.product,
          status: result.status,
          score: result.score,
          expectedContourFound: result.expectedContourFound,
          currentContourInsideTolerance: result.currentContourInsideTolerance,
          timestamp: Date.now(),
        },
        window.location.origin,
      );
    }
  }, [embedMode, result]);

  const browserSupported = Boolean(
    navigator.mediaDevices?.getUserMedia &&
      window.Worker &&
      window.isSecureContext,
  );

  const refreshReferences = useCallback(() => {
    setReferences({
      product1: loadReference("product1") ?? undefined,
      product2: loadReference("product2") ?? undefined,
    });
  }, []);

  useEffect(() => {
    refreshReferences();
  }, [refreshReferences]);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraState("idle");
  }, []);

  const clearCapture = useCallback(() => {
    stopCamera();
    setCapture(null);
    setDetections(null);
    setNormalizedUrl(null);
    setResult(null);
    setBusy(false);
    setMessage("");
    setSuccess("");
  }, [stopCamera]);

  const processDetectionsRef = useRef<(found: Detection[]) => void>(() => {});

  useEffect(() => {
    if (!browserSupported) {
      setDetectorState("error");
      setMessage("Deze browser kan de camera of Web Worker niet gebruiken.");
      return;
    }

    const worker = new Worker(
      `${import.meta.env.BASE_URL}detector/worker.js`,
    );

    workerRef.current = worker;

    worker.onmessage = (
      event: MessageEvent<{
        type: string;
        detections?: Detection[];
        message?: string;
      }>,
    ) => {
      if (event.data.type === "ready") {
        setDetectorState("ready");
        return;
      }

      if (event.data.type === "detections") {
        const found = event.data.detections ?? [];
        setDetections(found);
        processDetectionsRef.current(found);
        return;
      }

      if (event.data.type === "error") {
        setDetectorState("error");
        setBusy(false);
        setMessage(
          event.data.message ?? "AprilTag detector kon niet gestart worden.",
        );
      }
    };

    worker.onerror = () => {
      setDetectorState("error");
      setBusy(false);
      setMessage("AprilTag detector kon niet geladen worden.");
    };

    worker.postMessage({ type: "init" });

    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      worker.terminate();
    };
  }, [browserSupported]);

  const openCamera = useCallback(
    async (captureMode: CaptureMode, product: ProductId) => {
      clearCapture();

      selectedProductRef.current = product;
      captureModeRef.current = captureMode;
      setSelectedProduct(product);
      setCameraState("opening");

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        streamRef.current = stream;

        // The <video> is always mounted in CameraPanel.
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );

        if (!videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          setCameraState("error");
          setMessage("Cameraweergave kon niet worden opgebouwd.");
          return;
        }

        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        setCameraState("ready");
      } catch {
        setCameraState("error");
        setMessage(
          "Camera kon niet geopend worden. Controleer de cameratoestemming.",
        );
      }
    },
    [clearCapture],
  );

  const detectCapturedImage = useCallback(
    (width: number, height: number) => {
      if (
        !canvasRef.current ||
        !workerRef.current ||
        detectorState !== "ready"
      ) {
        setBusy(false);
        setMessage("AprilTag detector is nog niet klaar.");
        return;
      }

      const ctx = canvasRef.current.getContext("2d");
      if (!ctx) return;

      const image = ctx.getImageData(0, 0, width, height);
      const gray = new Uint8Array(width * height);

      for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
        gray[p] = Math.round(
          image.data[i] * 0.299 +
            image.data[i + 1] * 0.587 +
            image.data[i + 2] * 0.114,
        );
      }

      workerRef.current.postMessage(
        {
          type: "detect",
          pixels: gray.buffer,
          width,
          height,
        },
        [gray.buffer],
      );
    },
    [detectorState],
  );

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;

    if (
      !video ||
      !canvas ||
      !video.videoWidth ||
      !video.videoHeight ||
      cameraState !== "ready"
    ) {
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const nextCapture: Capture = {
      url: canvas.toDataURL("image/jpeg", 0.94),
      width: canvas.width,
      height: canvas.height,
    };

    setCapture(nextCapture);
    setDetections(null);
    setNormalizedUrl(null);
    setResult(null);
    setMessage("");
    setSuccess("");
    setBusy(true);

    stopCamera();

    window.setTimeout(
      () => detectCapturedImage(nextCapture.width, nextCapture.height),
      0,
    );
  }, [cameraState, detectCapturedImage, stopCamera]);

  const processDetections = useCallback(
    async (found: Detection[]) => {
      const missing = EXPECTED_IDS.filter(
        (id) => !found.some((d) => d.id === id),
      );

      if (missing.length > 0) {
        setBusy(false);
        setResult(null);
        setMessage(
          `Controle niet mogelijk: ${
            4 - missing.length
          }/4 AprilTags gevonden. Ontbrekend: ${missing.join(", ")}.`,
        );
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      try {
        const source = ctx.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );

        const normalized = normalizeImage(source, found);

        if (!normalized) {
          setBusy(false);
          setMessage(
            "Perspectiefcorrectie mislukt. Zorg dat alle vier tags volledig zichtbaar zijn.",
          );
          return;
        }

        const normalizedImageUrl = imageDataToUrl(normalized);
        setNormalizedUrl(normalizedImageUrl);

        const product = selectedProductRef.current;

        if (captureModeRef.current === "reference") {
          saveReference(product, normalizedImageUrl);
          refreshReferences();

          setBusy(false);
          setSuccess(
            `${productLabel(product)} is opgeslagen als perfecte referentie.`,
          );
          setMessage("");
          return;
        }

        const stored = loadReference(product);

        if (!stored) {
          setBusy(false);
          setMessage(
            `Geen referentie gevonden voor ${productLabel(product)}. Een beheerder moet deze eerst instellen.`,
          );
          return;
        }

        const referenceImage = await imageUrlToImageData(stored.imageUrl);

        const inspection = inspectAgainstReference(
          product,
          normalized,
          referenceImage,
        );

        setResult(inspection);
        setBusy(false);
        setMessage("");
      } catch (error) {
        console.error(error);
        setBusy(false);
        setResult(null);
        setMessage("De foto kon niet worden verwerkt.");
      }
    },
    [refreshReferences],
  );

  processDetectionsRef.current = processDetections;

  const unlockAdmin = useCallback(() => {
    if (pin === ADMIN_PIN) {
      setAdminUnlocked(true);
      setPinError(false);
    } else {
      setPinError(true);
    }
  }, [pin]);

  const removeReference = useCallback(
    (product: ProductId) => {
      deleteReference(product);
      refreshReferences();
      clearCapture();
      setSuccess(`${productLabel(product)} referentie verwijderd.`);
    },
    [clearCapture, refreshReferences],
  );

  const goToControl = useCallback(() => {
    clearCapture();
    setPageMode("control");

    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${window.location.hash}`,
    );
  }, [clearCapture]);

  const foundIds = useMemo(
    () => new Set((detections ?? []).map((d) => d.id)),
    [detections],
  );

  if (pageMode === "setup" && !adminUnlocked) {
    return (
      <div className="app-shell">
        <header className="industrial-header">
          <div>
            <span className="eyebrow">BEHEER · EINDCONTROLE</span>
            <h1>Referentie-instelling</h1>
          </div>
        </header>

        <main className="main-wrap narrow">
          <section className="pin-card">
            <div className="pin-icon">
              <LockKeyhole size={34} />
            </div>

            <h2>Beheerderstoegang</h2>

            <p>
              Hier worden de perfecte referenties voor Product 1 en
              Product 2 ingesteld. De operator heeft hier geen toegang toe.
            </p>

            <input
              value={pin}
              onChange={(event) => {
                setPin(event.target.value);
                setPinError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") unlockAdmin();
              }}
              type="password"
              inputMode="numeric"
              maxLength={4}
              placeholder="PIN"
            />

            {pinError && (
              <div className="message error">
                <AlertTriangle size={18} />
                Verkeerde PIN
              </div>
            )}

            <button className="button primary full" onClick={unlockAdmin}>
              <LockKeyhole size={19} />
              Beheer openen
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (pageMode === "setup") {
    return (
      <div className="app-shell">
        <header className="industrial-header">
          <div>
            <span className="eyebrow">BEHEER · EINDCONTROLE</span>
            <h1>Perfecte productreferenties</h1>
          </div>
        </header>

        <main className="main-wrap">
          <section className="info-card">
            <ShieldCheck size={22} />
            <div>
              <strong>Eenmalig instellen op de camera-telefoon</strong>
              <p>
                Maak één correcte foto van elk product. De app trekt die
                met AprilTags recht naar {NORMALIZED_WIDTH} ×{" "}
                {NORMALIZED_HEIGHT} en bewaart ze lokaal in deze browser.
              </p>
            </div>
          </section>

          <div className="reference-grid">
            {(["product1", "product2"] as ProductId[]).map((product) => {
              const reference = references[product];

              return (
                <section className="reference-card" key={product}>
                  <div className="reference-top">
                    <div>
                      <span className="eyebrow dark">PERFECTE REFERENTIE</span>
                      <h2>{productLabel(product)}</h2>
                      <p>{productDescription(product)}</p>
                    </div>

                    <span
                      className={`status-pill ${
                        reference ? "ok" : "warn"
                      }`}
                    >
                      {reference ? (
                        <>
                          <Check size={15} /> OPGESLAGEN
                        </>
                      ) : (
                        <>
                          <AlertTriangle size={15} /> NOG NODIG
                        </>
                      )}
                    </span>
                  </div>

                  {reference && (
                    <img
                      className="reference-preview"
                      src={reference.imageUrl}
                      alt={`${productLabel(product)} referentie`}
                    />
                  )}

                  <div className="reference-actions">
                    <button
                      className="button primary"
                      onClick={() => openCamera("reference", product)}
                      disabled={detectorState !== "ready"}
                    >
                      <ImagePlus size={17} />
                      {reference
                        ? "Nieuwe referentie maken"
                        : "Referentie maken"}
                    </button>

                    {reference && (
                      <button
                        className="button danger"
                        onClick={() => removeReference(product)}
                      >
                        <Trash2 size={17} />
                        Verwijderen
                      </button>
                    )}
                  </div>
                </section>
              );
            })}
          </div>

          <CameraPanel
            cameraState={cameraState}
            capture={capture}
            detections={detections}
            foundIds={foundIds}
            busy={busy}
            normalizedUrl={normalizedUrl}
            result={null}
            selectedProduct={selectedProduct}
            videoRef={videoRef}
            canvasRef={canvasRef}
            onTakePhoto={takePhoto}
            onReset={clearCapture}
            hiddenWhenIdle
            title="Referentiefoto"
          />

          {message && <Message kind="error">{message}</Message>}
          {success && <Message kind="success">{success}</Message>}

          <button
            className="button primary full continue"
            onClick={goToControl}
            disabled={!references.product1 || !references.product2}
          >
            Naar productcontrole
            <ChevronRight size={19} />
          </button>

          {(!references.product1 || !references.product2) && (
            <p className="center-hint">
              Stel eerst beide productreferenties in.
            </p>
          )}
        </main>
      </div>
    );
  }

  const selectedReference = references[selectedProduct];

  return (
    <div className={`app-shell ${embedMode ? "embedded" : ""}`}>
      {!embedMode && (
        <header className="industrial-header">
          <div>
            <span className="eyebrow">CAMERA · EINDCONTROLE</span>
            <h1>Visuele productcontrole</h1>
          </div>
        </header>
      )}

      <main className={embedMode ? "main-wrap embedded-main" : "main-wrap"}>
        {!embedMode && (
          <section className="info-card">
          <Eye size={22} />
          <div>
            <strong>Contour-overlay met AprilTag-correctie</strong>
            <p>
              De nieuwe foto wordt rechtgetrokken en vergeleken met de
              perfecte referentie. Minstens{" "}
              De contour wordt met een ruimere tolerantie vergeleken.
              Verwachte contour moet minstens {Math.round(EXPECTED_CONTOUR_THRESHOLD * 100)}%
              scoren en de huidige contour minstens {Math.round(PLACEMENT_CONTOUR_THRESHOLD * 100)}%.
            </p>
          </div>
        </section>
        )}

        {!embedMode && (
        <div className="product-grid">
          {(["product1", "product2"] as ProductId[]).map((product) => {
            const active = selectedProduct === product;
            const available = Boolean(references[product]);

            return (
              <button
                className={`product-card ${active ? "active" : ""}`}
                key={product}
                onClick={() => {
                  clearCapture();
                  selectedProductRef.current = product;
                  setSelectedProduct(product);
                }}
              >
                <span className="product-index">
                  {product === "product1" ? "01" : "02"}
                </span>

                <span className="product-copy">
                  <strong>{productLabel(product)}</strong>
                  <small>{productDescription(product)}</small>
                </span>

                <span
                  className={`status-pill compact ${
                    available ? "ok" : "warn"
                  }`}
                >
                  {available ? "REFERENTIE OK" : "GEEN REFERENTIE"}
                </span>
              </button>
            );
          })}
        </div>
        )}

        {!selectedReference && (
          <Message kind="error">
            Voor {productLabel(selectedProduct)} is nog geen referentie
            ingesteld.
          </Message>
        )}

        {cameraState === "idle" && !capture && (
          <button
            className="button primary full camera-open"
            onClick={() => openCamera("inspection", selectedProduct)}
            disabled={!selectedReference || detectorState !== "ready"}
          >
            <Camera size={20} />
            Camera openen voor {productLabel(selectedProduct)}
          </button>
        )}

        <CameraPanel
          cameraState={cameraState}
          capture={capture}
          detections={detections}
          foundIds={foundIds}
          busy={busy}
          normalizedUrl={normalizedUrl}
          result={result}
          selectedProduct={selectedProduct}
          videoRef={videoRef}
          canvasRef={canvasRef}
          onTakePhoto={takePhoto}
          onReset={clearCapture}
          hiddenWhenIdle
          title={`${productLabel(selectedProduct)} controleren`}
        />

        {message && <Message kind="error">{message}</Message>}
      </main>
    </div>
  );
}

function Message({
  kind,
  children,
}: {
  kind: "error" | "success";
  children: React.ReactNode;
}) {
  return (
    <div className={`message ${kind}`}>
      {kind === "error" ? (
        <AlertTriangle size={18} />
      ) : (
        <Check size={18} />
      )}
      <span>{children}</span>
    </div>
  );
}

function CameraPanel({
  cameraState,
  capture,
  detections,
  foundIds,
  busy,
  normalizedUrl,
  result,
  selectedProduct,
  videoRef,
  canvasRef,
  onTakePhoto,
  onReset,
  hiddenWhenIdle,
  title,
}: {
  cameraState: CameraState;
  capture: Capture | null;
  detections: Detection[] | null;
  foundIds: Set<number>;
  busy: boolean;
  normalizedUrl: string | null;
  result: OverlayInspectionResult | null;
  selectedProduct: ProductId;
  videoRef: RefObject<HTMLVideoElement>;
  canvasRef: RefObject<HTMLCanvasElement>;
  onTakePhoto: () => void;
  onReset: () => void;
  hiddenWhenIdle?: boolean;
  title: string;
}) {
  const idleAndEmpty = cameraState === "idle" && !capture;

  if (hiddenWhenIdle && idleAndEmpty) {
    return (
      <>
        <video ref={videoRef} className="hidden-video" playsInline muted />
        <canvas ref={canvasRef} hidden />
      </>
    );
  }

  return (
    <section className="camera-panel">
      <div className="panel-heading">
        <div>
          <span className="eyebrow dark">CAMERA</span>
          <h2>{title}</h2>
        </div>

        {detections && (
          <span
            className={`status-pill ${
              EXPECTED_IDS.every((id) => foundIds.has(id)) ? "ok" : "warn"
            }`}
          >
            {EXPECTED_IDS.filter((id) => foundIds.has(id)).length}/4 TAGS
          </span>
        )}
      </div>

      <div className="camera-stage">
        {!capture && (
          <video
            ref={videoRef}
            className={`camera-video ${
              cameraState === "ready" ? "visible" : ""
            }`}
            playsInline
            muted
            autoPlay
          />
        )}

        {capture && (
          <img
            className="capture-image"
            src={capture.url}
            alt="Genomen foto"
          />
        )}

        {cameraState === "opening" && (
          <div className="camera-overlay">
            <LoaderCircle className="spin" size={42} />
            <strong>Camera openen…</strong>
          </div>
        )}

        {busy && (
          <div className="camera-overlay">
            <LoaderCircle className="spin" size={42} />
            <strong>Foto analyseren…</strong>
            <span>AprilTags → 810 × 650 → contourvergelijking</span>
          </div>
        )}

        {cameraState === "ready" && !capture && (
          <>
            <span className="live-chip">● LIVE</span>
            <div className="guide-frame">
              <span>HOUD ALLE 4 APRILTAGS IN BEELD</span>
            </div>
          </>
        )}
      </div>

      <canvas ref={canvasRef} hidden />

      {cameraState === "ready" && !capture && (
        <button className="button primary full" onClick={onTakePhoto}>
          <ScanLine size={19} />
          Foto nemen en analyseren
        </button>
      )}

      {capture && !busy && (
        <button className="button quiet full" onClick={onReset}>
          <RotateCcw size={18} />
          Nieuwe foto
        </button>
      )}

      {normalizedUrl && !result && (
        <div className="normalized-card">
          <span className="eyebrow dark">
            GENORMALISEERD · {NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT}
          </span>
          <img src={normalizedUrl} alt="Genormaliseerd beeld" />
        </div>
      )}

      {result && (
        <section className="result-card">
          <div className={`result-banner ${result.status}`}>
            <div className="result-symbol">
              {result.status === "ok" ? (
                <Check size={30} />
              ) : (
                <X size={30} />
              )}
            </div>

            <div>
              <span className="eyebrow dark">
                {productLabel(selectedProduct).toUpperCase()}
              </span>
              <h2>
                {result.status === "ok"
                  ? "Product goedgekeurd"
                  : "Product afgekeurd"}
              </h2>
              <p>
                Eindscore: {Math.round(result.score * 100)}%
              </p>
            </div>
          </div>

          <div className="overlay-card">
            <div className="overlay-title">
              <div>
                <span className="eyebrow dark">VISUELE OVERLAY</span>
                <h3>Contourvergelijking</h3>
              </div>

              <div className="legend">
                <span><i className="green" /> goed gematcht</span>
                <span><i className="yellow" /> verwacht maar ontbreekt</span>
                <span><i className="red" /> onverwachte contour</span>
              </div>
            </div>

            <img
              className="overlay-image"
              src={result.overlayUrl}
              alt="Contour overlay"
            />
          </div>

          <div className="score-grid">
            <div
              className={
                result.expectedContourFound >= result.expectedThreshold
                  ? "score-box pass"
                  : "score-box fail"
              }
            >
              <span>Verwachte contour gevonden</span>
              <strong>
                {Math.round(result.expectedContourFound * 100)}%
              </strong>
              <small>
                ontbrekende onderdelen verlagen deze score
              </small>
            </div>

            <div
              className={
                result.currentContourInsideTolerance >= result.placementThreshold
                  ? "score-box pass"
                  : "score-box fail"
              }
            >
              <span>Huidige contour op juiste plaats</span>
              <strong>
                {Math.round(
                  result.currentContourInsideTolerance * 100,
                )}
                %
              </strong>
              <small>
                verkeerd geplaatste onderdelen verlagen deze score
              </small>
            </div>
          </div>

          <div className="decision-rule">
            Goedkeuring vereist: verwachte contour ≥{" "}
            {Math.round(result.expectedThreshold * 100)}% en huidige contour ≥{" "}
            {Math.round(result.placementThreshold * 100)}%.
          </div>
        </section>
      )}
    </section>
  );
}
