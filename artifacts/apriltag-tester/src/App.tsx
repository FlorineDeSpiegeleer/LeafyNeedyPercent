import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  LoaderCircle,
  RotateCcw,
  ScanLine,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  NORMALIZED_HEIGHT,
  NORMALIZED_WIDTH,
  PRODUCT1_ZONES,
  type Detection,
  type InspectionResult,
  imageDataToUrl,
  inspectProduct1,
  normalizeImage,
} from '@/lib/inspection';

type CameraState = 'idle' | 'opening' | 'ready' | 'error';
type DetectorState = 'checking' | 'ready' | 'error';
type Capture = { url: string; width: number; height: number };
type NormalizedView = { url: string; imageData: ImageData };

const EXPECTED_IDS = [0, 1, 2, 3];

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [detectorState, setDetectorState] = useState<DetectorState>('checking');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [detections, setDetections] = useState<Detection[] | null>(null);
  const [normalizedView, setNormalizedView] = useState<NormalizedView | null>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [debug, setDebug] = useState(false);

  const browserSupported = Boolean(
    navigator.mediaDevices?.getUserMedia && window.Worker && window.isSecureContext,
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (cameraState === 'ready') setCameraState('idle');
  }, [cameraState]);

  useEffect(() => {
    if (!browserSupported) {
      setDetectorState('error');
      setMessage('Cameratoegang vereist HTTPS en een ondersteunde browser.');
      return;
    }

    const worker = new Worker(`${import.meta.env.BASE_URL}detector/worker.js`);
    workerRef.current = worker;

    worker.onmessage = (event: MessageEvent<{ type: string; detections?: Detection[]; message?: string }>) => {
      if (event.data.type === 'ready') {
        setDetectorState('ready');
      } else if (event.data.type === 'detections') {
        const found = event.data.detections ?? [];
        setDetections(found);
        processDetections(found);
      } else if (event.data.type === 'error') {
        setDetectorState('error');
        setBusy(false);
        setMessage(event.data.message ?? 'AprilTag detector kon niet gestart worden.');
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCamera = useCallback(async () => {
    setMessage('');
    setCapture(null);
    setDetections(null);
    setNormalizedView(null);
    setInspection(null);
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
      setMessage('Camera kon niet geopend worden. Controleer de cameratoestemming.');
    }
  }, []);

  const detectTagsFromCanvas = useCallback((width: number, height: number) => {
    if (!canvasRef.current || !workerRef.current || detectorState !== 'ready') {
      setBusy(false);
      setMessage('AprilTag detector is nog niet klaar.');
      return;
    }

    const ctx = canvasRef.current.getContext('2d');
    if (!ctx) return;
    const image = ctx.getImageData(0, 0, width, height);
    const grayscale = new Uint8Array(width * height);

    for (let i = 0, p = 0; i < image.data.length; i += 4, p += 1) {
      grayscale[p] = Math.round(
        image.data[i] * 0.299 + image.data[i + 1] * 0.587 + image.data[i + 2] * 0.114,
      );
    }

    workerRef.current.postMessage(
      { type: 'detect', pixels: grayscale.buffer, width, height },
      [grayscale.buffer],
    );
  }, [detectorState]);

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || !video.videoHeight) return;

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

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
    setBusy(true);
    stopCamera();

    // Geen extra “Detect tags”-knop: de foto wordt direct geanalyseerd.
    window.setTimeout(() => detectTagsFromCanvas(photo.width, photo.height), 0);
  }, [detectTagsFromCanvas, stopCamera]);

  const processDetections = useCallback((found: Detection[]) => {
    const missing = EXPECTED_IDS.filter((id) => !found.some((d) => d.id === id));
    if (missing.length > 0) {
      setBusy(false);
      setNormalizedView(null);
      setInspection(null);
      setMessage(`Controle niet mogelijk — ${4 - missing.length}/4 referentietags gevonden. Ontbrekend: ${missing.join(', ')}.`);
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    try {
      const source = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const normalized = normalizeImage(source, found, NORMALIZED_WIDTH, NORMALIZED_HEIGHT);
      if (!normalized) {
        setBusy(false);
        setMessage('Perspectiefcorrectie mislukt. Zorg dat alle 4 tags volledig zichtbaar zijn.');
        return;
      }

      const view = { imageData: normalized, url: imageDataToUrl(normalized) };
      setNormalizedView(view);

      // De productcontrole gebeurt HIER op de pixels van de genomen foto,
      // nadat die via de 4 tags naar 810 × 650 is rechtgetrokken.
      const result = inspectProduct1(normalized, EXPECTED_IDS);
      setInspection(result);
      setBusy(false);
      setMessage('');
    } catch {
      setBusy(false);
      setMessage('De foto kon niet worden verwerkt. Neem een nieuwe foto.');
    }
  }, []);

  const reset = useCallback(() => {
    setCapture(null);
    setDetections(null);
    setNormalizedView(null);
    setInspection(null);
    setBusy(false);
    setMessage('');
    setCameraState('idle');
  }, []);

  const foundIds = useMemo(() => new Set((detections ?? []).map((d) => d.id)), [detections]);

  return (
    <div className="dw-app">
      <header className="dw-header">
        <button className="dw-back" onClick={reset} aria-label="Terug">
          <ArrowLeft size={24} />
        </button>
        <div>
          <p className="dw-eyebrow">CAMERA · PRODUCTCONTROLE</p>
          <h1>Eindcontrole product</h1>
        </div>
      </header>

      <main className="dw-main">
        <section className="dw-info">
          <ShieldCheck size={22} />
          <div>
            <strong>Automatische eindcontrole met AprilTags</strong>
            <p>Breng de vier referentietags en het volledige product in beeld. De foto wordt automatisch rechtgetrokken naar 810 × 650 en daarna gecontroleerd.</p>
          </div>
        </section>

        <section className="camera-card">
          <div className="camera-stage">
            {!capture && (
              <video
                ref={videoRef}
                autoPlay
                playsInline
                muted
                className={cameraState === 'ready' ? 'camera-video visible' : 'camera-video'}
              />
            )}

            {capture && <img src={capture.url} className="camera-photo" alt="Genomen controlefoto" />}

            {!capture && cameraState !== 'ready' && (
              <div className="camera-placeholder">
                <div className="camera-icon"><Camera size={46} /></div>
                <strong>{cameraState === 'opening' ? 'Camera openen…' : 'Camera nog niet geopend'}</strong>
                <span>Alle 4 AprilTags moeten volledig zichtbaar zijn.</span>
              </div>
            )}

            {cameraState === 'ready' && (
              <>
                <div className="live-pill">● LIVE</div>
                <div className="guide-frame">
                  <span>810 × 650 REFERENTIEVLAK</span>
                </div>
              </>
            )}

            {capture && detections && (
              <svg className="tag-overlay" viewBox={`0 0 ${capture.width} ${capture.height}`} preserveAspectRatio="xMidYMid meet">
                {detections.map((detection) => {
                  const points = detection.corners.map((c) => `${c.x},${c.y}`).join(' ');
                  const center = detection.center ?? detection.corners.reduce(
                    (acc, c) => ({ x: acc.x + c.x / 4, y: acc.y + c.y / 4 }),
                    { x: 0, y: 0 },
                  );
                  return (
                    <g key={`${detection.id}-${center.x}`}>
                      <polygon points={points} />
                      <text x={center.x + 9} y={center.y - 9}>ID {detection.id}</text>
                    </g>
                  );
                })}
              </svg>
            )}

            {busy && (
              <div className="processing-overlay">
                <LoaderCircle size={48} className="spin" />
                <strong>Foto analyseren…</strong>
                <span>AprilTags detecteren → perspectief corrigeren → product controleren</span>
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

          {!capture && cameraState !== 'ready' && (
            <button className="primary-action" onClick={openCamera} disabled={!browserSupported || detectorState !== 'ready' || cameraState === 'opening'}>
              {cameraState === 'opening' ? <LoaderCircle size={22} className="spin" /> : <Camera size={22} />}
              Camera openen
            </button>
          )}

          {!capture && cameraState === 'ready' && (
            <button className="primary-action" onClick={takePhoto}>
              <ScanLine size={22} /> Foto nemen en analyseren
            </button>
          )}

          {capture && !busy && (
            <button className="secondary-action" onClick={reset}>
              <RotateCcw size={20} /> Nieuwe foto
            </button>
          )}
        </section>

        {detections && (
          <section className="tag-status-card">
            <div className="card-title-row">
              <div>
                <p className="small-label">APRILTAG REFERENTIE</p>
                <h2>{EXPECTED_IDS.filter((id) => foundIds.has(id)).length}/4 tags gevonden</h2>
              </div>
              <span className={foundIds.size >= 4 ? 'status-badge ok' : 'status-badge nok'}>
                {foundIds.size >= 4 ? <Check size={16} /> : <X size={16} />}
                {foundIds.size >= 4 ? 'Referentie OK' : 'Onvolledig'}
              </span>
            </div>
            <div className="tag-chips">
              {EXPECTED_IDS.map((id) => (
                <span key={id} className={foundIds.has(id) ? 'tag-chip found' : 'tag-chip missing'}>
                  ID {id} {foundIds.has(id) ? '✓' : '×'}
                </span>
              ))}
            </div>
          </section>
        )}

        {normalizedView && inspection && (
          <section className="result-card">
            <div className={`result-banner ${inspection.status === 'ok' ? 'ok' : 'nok'}`}>
              <div className="result-icon">
                {inspection.status === 'ok' ? <Check size={34} /> : <X size={34} />}
              </div>
              <div>
                <p className="small-label">EINDCONTROLE PRODUCT 1</p>
                <h2>{inspection.status === 'ok' ? 'Product goedgekeurd' : 'Afwijking gedetecteerd'}</h2>
                <p>{inspection.status === 'ok' ? 'De verwachte productgeometrie is aanwezig.' : 'Minstens één onderdeel ligt niet op de verwachte plaats of ontbreekt.'}</p>
              </div>
            </div>

            <div className="normalized-section">
              <div className="normalized-heading">
                <div>
                  <p className="small-label">GENORMALISEERDE CAMERAFOTO</p>
                  <h3>{NORMALIZED_WIDTH} × {NORMALIZED_HEIGHT}</h3>
                </div>
                <button className="debug-toggle" onClick={() => setDebug((v) => !v)}>
                  {debug ? 'Zones verbergen' : 'Controlezones tonen'}
                </button>
              </div>

              <div className="normalized-stage">
                <img src={normalizedView.url} alt="Genormaliseerde productfoto" />
                {debug && (
                  <div className="roi-overlay">
                    {PRODUCT1_ZONES.map((zone) => {
                      const zoneResult = inspection.zones.find((z) => z.id === zone.id);
                      return (
                        <span
                          key={zone.id}
                          className={`roi ${zoneResult?.pass ? 'pass' : 'fail'}`}
                          style={{
                            left: `${zone.x * 100}%`,
                            top: `${zone.y * 100}%`,
                            width: `${zone.w * 100}%`,
                            height: `${zone.h * 100}%`,
                          }}
                        >
                          {zone.label}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="checks-grid">
              <CheckTile label="4 wielen" pass={inspection.checks.wheels} />
              <CheckTile label="Bovenprofiel" pass={inspection.checks.topProfile} />
              <CheckTile label="Onderprofiel" pass={inspection.checks.bottomProfile} />
              <CheckTile label="Middenprofiel" pass={inspection.checks.centerProfile} />
              <CheckTile label="Handvat" pass={inspection.checks.handle} />
            </div>

            {inspection.errors.length > 0 && (
              <div className="error-list">
                {inspection.errors.map((error) => (
                  <div key={error}><AlertTriangle size={17} /> {error}</div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

function CheckTile({ label, pass }: { label: string; pass: boolean }) {
  return (
    <div className={`check-tile ${pass ? 'pass' : 'fail'}`}>
      <span>{label}</span>
      <b>{pass ? 'OK' : 'NOK'}</b>
    </div>
  );
}
