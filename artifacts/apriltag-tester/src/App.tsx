import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  ImagePlus,
  LoaderCircle,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';

import {
  NORMALIZED_HEIGHT,
  NORMALIZED_WIDTH,
  PRODUCT1_COMPARISON_ZONES,
  REFERENCE_STORAGE_KEY,
  type Detection,
  type InspectionResult,
  compareProduct1WithReference,
  dataUrlToImageData,
  imageDataToUrl,
  normalizeImage,
} from '@/lib/inspection';

type CameraState = 'idle' | 'opening' | 'ready' | 'error';
type DetectorState = 'checking' | 'ready' | 'error';
type CapturePurpose = 'inspection' | 'reference';

type Capture = {
  url: string;
  width: number;
  height: number;
};

type NormalizedView = {
  url: string;
  imageData: ImageData;
};

const EXPECTED_IDS = [0, 1, 2, 3];

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const capturePurposeRef = useRef<CapturePurpose>('inspection');

  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [detectorState, setDetectorState] = useState<DetectorState>('checking');

  const [capturePurpose, setCapturePurpose] =
    useState<CapturePurpose>('inspection');

  const [capture, setCapture] = useState<Capture | null>(null);
  const [detections, setDetections] = useState<Detection[] | null>(null);
  const [normalizedView, setNormalizedView] =
    useState<NormalizedView | null>(null);

  const [referenceView, setReferenceView] =
    useState<NormalizedView | null>(null);

  const [referenceLoading, setReferenceLoading] = useState(true);

  const [inspection, setInspection] =
    useState<InspectionResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [debug, setDebug] = useState(false);

  const browserSupported = Boolean(
    navigator.mediaDevices?.getUserMedia &&
      window.Worker &&
      window.isSecureContext,
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraState((current) =>
      current === 'ready' ? 'idle' : current,
    );
  }, []);

  /**
   * Bestaande goede referentie uit deze browser laden.
   * De referentie blijft dus behouden na refresh / opnieuw openen.
   */
  useEffect(() => {
    let cancelled = false;

    const loadReference = async () => {
      try {
        const saved = window.localStorage.getItem(REFERENCE_STORAGE_KEY);

        if (!saved) {
          if (!cancelled) setReferenceLoading(false);
          return;
        }

        const imageData = await dataUrlToImageData(saved);

        if (!cancelled) {
          setReferenceView({
            imageData,
            url: saved,
          });
        }
      } catch {
        try {
          window.localStorage.removeItem(REFERENCE_STORAGE_KEY);
        } catch {
          // Geen probleem.
        }
      } finally {
        if (!cancelled) setReferenceLoading(false);
      }
    };

    loadReference();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Lokale AprilTag WASM-worker.
   */
  useEffect(() => {
    if (!browserSupported) {
      setDetectorState('error');
      setMessage(
        'Cameratoegang vereist HTTPS en een ondersteunde browser.',
      );
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
      if (event.data.type === 'ready') {
        setDetectorState('ready');
      } else if (event.data.type === 'detections') {
        const found = event.data.detections ?? [];

        setDetections(found);
        processDetections(found);
      } else if (event.data.type === 'error') {
        setDetectorState('error');
        setBusy(false);
        setMessage(
          event.data.message ??
            'AprilTag detector kon niet gestart worden.',
        );
      }
    };

    worker.onerror = () => {
      setDetectorState('error');
      setBusy(false);
      setMessage('AprilTag detector kon niet geladen worden.');
    };

    worker.postMessage({ type: 'init' });

    return () => {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      worker.terminate();
    };

    // processDetections gebruikt actuele refs/states via function closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearCurrentCapture = useCallback(() => {
    stopCamera();

    setCapture(null);
    setDetections(null);
    setNormalizedView(null);
    setInspection(null);
    setBusy(false);
    setMessage('');
    setSuccessMessage('');
    setCameraState('idle');
  }, [stopCamera]);

  const openCameraFor = useCallback(
    async (purpose: CapturePurpose) => {
      clearCurrentCapture();

      capturePurposeRef.current = purpose;
      setCapturePurpose(purpose);

      setCameraState('opening');

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
        });

        streamRef.current = stream;

        if (!videoRef.current) return;

        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        setCameraState('ready');
      } catch {
        setCameraState('error');
        setMessage(
          'Camera kon niet geopend worden. Controleer de cameratoestemming.',
        );
      }
    },
    [clearCurrentCapture],
  );

  const detectTagsFromCanvas = useCallback(
    (width: number, height: number) => {
      if (
        !canvasRef.current ||
        !workerRef.current ||
        detectorState !== 'ready'
      ) {
        setBusy(false);
        setMessage('AprilTag detector is nog niet klaar.');
        return;
      }

      const context = canvasRef.current.getContext('2d');
      if (!context) return;

      const image = context.getImageData(0, 0, width, height);
      const grayscale = new Uint8Array(width * height);

      for (
        let i = 0, p = 0;
        i < image.data.length;
        i += 4, p += 1
      ) {
        grayscale[p] = Math.round(
          image.data[i] * 0.299 +
            image.data[i + 1] * 0.587 +
            image.data[i + 2] * 0.114,
        );
      }

      workerRef.current.postMessage(
        {
          type: 'detect',
          pixels: grayscale.buffer,
          width,
          height,
        },
        [grayscale.buffer],
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
      !video.videoHeight
    ) {
      return;
    }

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const context = canvas.getContext('2d');
    if (!context) return;

    context.drawImage(
      video,
      0,
      0,
      canvas.width,
      canvas.height,
    );

    const photo: Capture = {
      url: canvas.toDataURL('image/jpeg', 0.94),
      width: canvas.width,
      height: canvas.height,
    };

    setCapture(photo);
    setDetections(null);
    setNormalizedView(null);
    setInspection(null);
    setMessage('');
    setSuccessMessage('');
    setBusy(true);

    stopCamera();

    window.setTimeout(
      () => detectTagsFromCanvas(photo.width, photo.height),
      0,
    );
  }, [detectTagsFromCanvas, stopCamera]);

  /**
   * Zodra de detector de 4 tags terugstuurt:
   * 1. normaliseer de ECHTE genomen foto naar 810 × 650;
   * 2a. referentiemodus -> sla dit beeld op als correcte referentie;
   * 2b. inspectiemodus -> vergelijk dit beeld met die referentie.
   */
  const processDetections = useCallback(
    (found: Detection[]) => {
      const missing = EXPECTED_IDS.filter(
        (id) => !found.some((detection) => detection.id === id),
      );

      if (missing.length > 0) {
        setBusy(false);
        setNormalizedView(null);
        setInspection(null);

        setMessage(
          `Controle niet mogelijk — ${
            4 - missing.length
          }/4 referentietags gevonden. Ontbrekend: ${missing.join(', ')}.`,
        );

        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const context = canvas.getContext('2d');
      if (!context) return;

      try {
        const source = context.getImageData(
          0,
          0,
          canvas.width,
          canvas.height,
        );

        const normalized = normalizeImage(
          source,
          found,
          NORMALIZED_WIDTH,
          NORMALIZED_HEIGHT,
        );

        if (!normalized) {
          setBusy(false);
          setMessage(
            'Perspectiefcorrectie mislukt. Zorg dat alle 4 tags volledig zichtbaar zijn.',
          );
          return;
        }

        const normalizedUrl = imageDataToUrl(normalized, 0.94);

        const view: NormalizedView = {
          imageData: normalized,
          url: normalizedUrl,
        };

        setNormalizedView(view);

        if (capturePurposeRef.current === 'reference') {
          try {
            window.localStorage.setItem(
              REFERENCE_STORAGE_KEY,
              normalizedUrl,
            );

            setReferenceView(view);
            setInspection(null);

            setSuccessMessage(
              'Correct Product 1 opgeslagen als nieuwe referentie.',
            );
            setMessage('');
          } catch {
            setMessage(
              'Referentie kon niet in deze browser worden opgeslagen.',
            );
          }

          setBusy(false);
          return;
        }

        if (!referenceView) {
          setBusy(false);
          setInspection(null);

          setMessage(
            'Nog geen correcte referentiefoto opgeslagen. Stel eerst de referentie in.',
          );

          return;
        }

        const result = compareProduct1WithReference(
          normalized,
          referenceView.imageData,
          EXPECTED_IDS,
        );

        setInspection(result);
        setBusy(false);
        setMessage('');
      } catch (error) {
        console.error(error);

        setBusy(false);
        setInspection(null);

        setMessage(
          'De foto kon niet worden verwerkt. Neem een nieuwe foto.',
        );
      }
    },
    [referenceView],
  );

  /**
   * Referentie volledig wissen.
   */
  const deleteReference = useCallback(() => {
    try {
      window.localStorage.removeItem(REFERENCE_STORAGE_KEY);
    } catch {
      // Geen probleem.
    }

    setReferenceView(null);
    setInspection(null);
    setNormalizedView(null);
    setMessage('');
    setSuccessMessage('Referentiefoto verwijderd.');
  }, []);

  const reset = useCallback(() => {
    clearCurrentCapture();
    setCapturePurpose('inspection');
    capturePurposeRef.current = 'inspection';
  }, [clearCurrentCapture]);

  const foundIds = useMemo(
    () => new Set((detections ?? []).map((detection) => detection.id)),
    [detections],
  );

  return (
    <div className="dw-app">
      <header className="dw-header">
        <button
          className="dw-back"
          onClick={reset}
          aria-label="Terug"
        >
          <ArrowLeft size={24} />
        </button>

        <div>
          <p className="dw-eyebrow">CAMERA · PRODUCTCONTROLE</p>
          <h1>Eindcontrole Product 1</h1>
        </div>
      </header>

      <main className="dw-main">
        <section className="dw-info">
          <ShieldCheck size={22} />

          <div>
            <strong>
              Vergelijking met echte correcte referentiefoto
            </strong>

            <p>
              Beide foto&apos;s worden via AprilTags naar exact
              {` ${NORMALIZED_WIDTH} × ${NORMALIZED_HEIGHT} `}
              rechtgetrokken. Daarna wordt de randgeometrie per onderdeel
              vergeleken.
            </p>
          </div>
        </section>

        <section className="reference-card">
          <div className="reference-card-heading">
            <div>
              <p className="small-label">CORRECTE REFERENTIE</p>

              <h2>
                {referenceLoading
                  ? 'Referentie laden…'
                  : referenceView
                    ? 'Referentie ingesteld'
                    : 'Nog geen referentie'}
              </h2>

              <p>
                Gebruik één volledig correct Product 1. Deze foto hoeft
                maar opnieuw ingesteld te worden wanneer de fysieke
                opstelling of tagpositie verandert.
              </p>
            </div>

            <span
              className={`reference-status ${
                referenceView ? 'ready' : 'missing'
              }`}
            >
              {referenceView ? (
                <>
                  <Check size={16} /> KLAAR
                </>
              ) : (
                <>
                  <AlertTriangle size={16} /> NODIG
                </>
              )}
            </span>
          </div>

          {referenceView && (
            <div className="reference-preview">
              <img
                src={referenceView.url}
                alt="Opgeslagen correcte referentie"
              />

              <div>
                <strong>Product 1 · correcte toestand</strong>
                <span>
                  {NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT} px
                </span>
              </div>
            </div>
          )}

          <div className="reference-actions">
            <button
              className="reference-action primary"
              onClick={() => openCameraFor('reference')}
              disabled={
                detectorState !== 'ready' ||
                cameraState === 'opening'
              }
            >
              <ImagePlus size={19} />
              {referenceView
                ? 'Nieuwe referentie maken'
                : 'Referentie instellen'}
            </button>

            {referenceView && (
              <button
                className="reference-action danger"
                onClick={deleteReference}
              >
                <Trash2 size={18} />
                Verwijderen
              </button>
            )}
          </div>
        </section>

        <section className="camera-card">
          <div className="capture-mode-bar">
            <span
              className={`capture-mode-pill ${
                capturePurpose === 'reference' ? 'reference' : 'inspection'
              }`}
            >
              {capturePurpose === 'reference'
                ? 'REFERENTIE OPNEMEN'
                : 'PRODUCT CONTROLEREN'}
            </span>

            {capturePurpose === 'inspection' && !referenceView && (
              <span className="capture-mode-warning">
                Eerst referentie instellen
              </span>
            )}
          </div>

          <div className="camera-stage">
            {!capture && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={
                  cameraState === 'ready'
                    ? 'camera-video visible'
                    : 'camera-video'
                }
              />
            )}

            {capture && (
              <img
                src={capture.url}
                className="camera-photo"
                alt="Genomen controlefoto"
              />
            )}

            {!capture && cameraState !== 'ready' && (
              <div className="camera-placeholder">
                <div className="camera-icon">
                  <Camera size={46} />
                </div>

                <strong>
                  {cameraState === 'opening'
                    ? 'Camera openen…'
                    : 'Camera nog niet geopend'}
                </strong>

                <span>
                  Alle 4 AprilTags moeten volledig zichtbaar zijn.
                </span>
              </div>
            )}

            {cameraState === 'ready' && (
              <>
                <div className="live-pill">● LIVE</div>

                <div className="guide-frame">
                  <span>
                    {NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT} REFERENTIEVLAK
                  </span>
                </div>
              </>
            )}

            {capture && detections && (
              <svg
                className="tag-overlay"
                viewBox={`0 0 ${capture.width} ${capture.height}`}
                preserveAspectRatio="xMidYMid meet"
              >
                {detections.map((detection) => {
                  const points = detection.corners
                    .map((corner) => `${corner.x},${corner.y}`)
                    .join(' ');

                  const center =
                    detection.center ??
                    detection.corners.reduce(
                      (acc, corner) => ({
                        x: acc.x + corner.x / 4,
                        y: acc.y + corner.y / 4,
                      }),
                      { x: 0, y: 0 },
                    );

                  return (
                    <g key={`${detection.id}-${center.x}`}>
                      <polygon points={points} />

                      <text
                        x={center.x + 9}
                        y={center.y - 9}
                      >
                        ID {detection.id}
                      </text>
                    </g>
                  );
                })}
              </svg>
            )}

            {busy && (
              <div className="processing-overlay">
                <LoaderCircle size={48} className="spin" />

                <strong>
                  {capturePurpose === 'reference'
                    ? 'Referentie voorbereiden…'
                    : 'Product vergelijken…'}
                </strong>

                <span>
                  AprilTags → 810 × 650 →{' '}
                  {capturePurpose === 'reference'
                    ? 'referentie opslaan'
                    : 'edge matching'}
                </span>
              </div>
            )}
          </div>

          <canvas ref={canvasRef} hidden />

          {message && (
            <div className="dw-error">
              <AlertTriangle size={20} />
              <span>{message}</span>
            </div>
          )}

          {successMessage && (
            <div className="dw-success">
              <Check size={20} />
              <span>{successMessage}</span>
            </div>
          )}

          {!capture && cameraState !== 'ready' && (
            <button
              className="primary-action"
              onClick={() => openCameraFor('inspection')}
              disabled={
                !browserSupported ||
                detectorState !== 'ready' ||
                cameraState === 'opening' ||
                !referenceView
              }
            >
              {cameraState === 'opening' ? (
                <LoaderCircle size={22} className="spin" />
              ) : (
                <Camera size={22} />
              )}

              {referenceView
                ? 'Camera openen voor controle'
                : 'Eerst referentie instellen'}
            </button>
          )}

          {!capture && cameraState === 'ready' && (
            <button className="primary-action" onClick={takePhoto}>
              <ScanLine size={22} />

              {capturePurpose === 'reference'
                ? 'Foto nemen en als referentie opslaan'
                : 'Foto nemen en vergelijken'}
            </button>
          )}

          {capture && !busy && (
            <button
              className="secondary-action"
              onClick={clearCurrentCapture}
            >
              <RotateCcw size={20} />
              Nieuwe foto
            </button>
          )}
        </section>

        {detections && (
          <section className="tag-status-card">
            <div className="card-title-row">
              <div>
                <p className="small-label">APRILTAG REFERENTIE</p>

                <h2>
                  {
                    EXPECTED_IDS.filter((id) => foundIds.has(id))
                      .length
                  }
                  /4 tags gevonden
                </h2>
              </div>

              <span
                className={
                  EXPECTED_IDS.every((id) => foundIds.has(id))
                    ? 'status-badge ok'
                    : 'status-badge nok'
                }
              >
                {EXPECTED_IDS.every((id) => foundIds.has(id)) ? (
                  <Check size={16} />
                ) : (
                  <X size={16} />
                )}

                {EXPECTED_IDS.every((id) => foundIds.has(id))
                  ? 'Referentie OK'
                  : 'Onvolledig'}
              </span>
            </div>

            <div className="tag-chips">
              {EXPECTED_IDS.map((id) => (
                <span
                  key={id}
                  className={
                    foundIds.has(id)
                      ? 'tag-chip found'
                      : 'tag-chip missing'
                  }
                >
                  ID {id} {foundIds.has(id) ? '✓' : '×'}
                </span>
              ))}
            </div>
          </section>
        )}

        {normalizedView && capturePurpose === 'reference' && (
          <section className="result-card">
            <div className="result-banner ok">
              <div className="result-icon">
                <Check size={34} />
              </div>

              <div>
                <p className="small-label">REFERENTIEFOTO</p>
                <h2>Correct product opgeslagen</h2>

                <p>
                  Dit genormaliseerde beeld wordt voortaan als
                  vergelijkingsbasis gebruikt.
                </p>
              </div>
            </div>

            <div className="normalized-section">
              <div className="normalized-heading">
                <div>
                  <p className="small-label">
                    GENORMALISEERDE REFERENTIE
                  </p>

                  <h3>
                    {NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT}
                  </h3>
                </div>
              </div>

              <div className="normalized-stage">
                <img
                  src={normalizedView.url}
                  alt="Nieuwe genormaliseerde referentie"
                />
              </div>
            </div>
          </section>
        )}

        {normalizedView &&
          inspection &&
          capturePurpose === 'inspection' && (
            <section className="result-card">
              <div
                className={`result-banner ${
                  inspection.status === 'ok' ? 'ok' : 'nok'
                }`}
              >
                <div className="result-icon">
                  {inspection.status === 'ok' ? (
                    <Check size={34} />
                  ) : (
                    <X size={34} />
                  )}
                </div>

                <div>
                  <p className="small-label">
                    EINDCONTROLE PRODUCT 1
                  </p>

                  <h2>
                    {inspection.status === 'ok'
                      ? 'Product goedgekeurd'
                      : 'Afwijking gedetecteerd'}
                  </h2>

                  <p>
                    Totale referentiematch:{' '}
                    <strong>
                      {Math.round(
                        inspection.overallSimilarity * 100,
                      )}
                      %
                    </strong>
                  </p>
                </div>
              </div>

              <div className="normalized-section">
                <div className="normalized-heading">
                  <div>
                    <p className="small-label">
                      NIEUWE GENORMALISEERDE CAMERAFOTO
                    </p>

                    <h3>
                      {NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT}
                    </h3>
                  </div>

                  <button
                    className="debug-toggle"
                    onClick={() => setDebug((value) => !value)}
                  >
                    {debug
                      ? 'Zones verbergen'
                      : 'Vergelijkingszones tonen'}
                  </button>
                </div>

                <div className="normalized-stage">
                  <img
                    src={normalizedView.url}
                    alt="Genormaliseerde productfoto"
                  />

                  {debug && (
                    <div className="roi-overlay">
                      {PRODUCT1_COMPARISON_ZONES.map((zone) => {
                        const result = inspection.zones.find(
                          (item) => item.id === zone.id,
                        );

                        return (
                          <span
                            key={zone.id}
                            className={`roi ${
                              result?.pass ? 'pass' : 'fail'
                            }`}
                            style={{
                              left: `${zone.x * 100}%`,
                              top: `${zone.y * 100}%`,
                              width: `${zone.w * 100}%`,
                              height: `${zone.h * 100}%`,
                            }}
                          >
                            {zone.label}{' '}
                            {Math.round(
                              (result?.similarity ?? 0) * 100,
                            )}
                            %
                          </span>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>

              <div className="comparison-preview-grid">
                <div>
                  <p className="small-label">CORRECTE REFERENTIE</p>
                  <img
                    src={referenceView?.url}
                    alt="Correcte referentiefoto"
                  />
                </div>

                <div>
                  <p className="small-label">HUIDIGE FOTO</p>
                  <img
                    src={normalizedView.url}
                    alt="Huidige controlefoto"
                  />
                </div>
              </div>

              <div className="checks-grid">
                <CheckTile
                  label="4 wielen"
                  pass={inspection.checks.wheels}
                  score={inspection.scores.wheels}
                />

                <CheckTile
                  label="Bovenprofiel"
                  pass={inspection.checks.topProfile}
                  score={inspection.scores.topProfile}
                />

                <CheckTile
                  label="Onderprofiel"
                  pass={inspection.checks.bottomProfile}
                  score={inspection.scores.bottomProfile}
                />

                <CheckTile
                  label="Middenprofiel"
                  pass={inspection.checks.centerProfile}
                  score={inspection.scores.centerProfile}
                />

                <CheckTile
                  label="Handvat"
                  pass={inspection.checks.handle}
                  score={inspection.scores.handle}
                />
              </div>

              {inspection.errors.length > 0 && (
                <div className="error-list">
                  {inspection.errors.map((error) => (
                    <div key={error}>
                      <AlertTriangle size={17} />
                      {error}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
      </main>
    </div>
  );
}

function CheckTile({
  label,
  pass,
  score,
}: {
  label: string;
  pass: boolean;
  score: number;
}) {
  return (
    <div className={`check-tile ${pass ? 'pass' : 'fail'}`}>
      <span>{label}</span>

      <b>{pass ? 'OK' : 'NOK'}</b>

      <small>{Math.round(score * 100)}% match</small>
    </div>
  );
}
