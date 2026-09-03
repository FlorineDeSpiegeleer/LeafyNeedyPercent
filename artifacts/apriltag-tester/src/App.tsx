import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, Check, CircleHelp, Crosshair, Info, LoaderCircle, RotateCcw, ScanLine, ShieldCheck, SlidersHorizontal, Target, WandSparkles } from 'lucide-react';
import {
  NORMALIZED_SIZE,
  type Detection,
  type InspectionResult,
  type ProductConfig,
  type ProductId,
  type InspectionZone,
  imageDataToUrl,
  inspectNormalizedImage,
  loadProductConfigs,
  normalizeImage,
  resetProductConfigs,
  saveProductConfigs,
} from '@/lib/inspection';

type CameraState = 'unavailable' | 'idle' | 'opening' | 'ready' | 'error';
type DetectorState = 'checking' | 'ready' | 'error';
type Capture = { url: string; width: number; height: number };
type NormalizedView = { url: string; imageData: ImageData };

const EXPECTED_IDS = [0, 1, 2, 3];
const POSITION_LABELS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

function StatusDot({ state }: { state: 'ready' | 'warn' | 'error' | 'idle' }) {
  return <span className={`status-dot ${state === 'idle' ? '' : state}`} aria-hidden="true" />;
}

function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [detectorState, setDetectorState] = useState<DetectorState>('checking');
  const [browserSupported, setBrowserSupported] = useState(true);
  const [capture, setCapture] = useState<Capture | null>(null);
  const [detections, setDetections] = useState<Detection[] | null>(null);
  const [isDetecting, setIsDetecting] = useState(false);
  const [cameraMessage, setCameraMessage] = useState('');
  const [detectorMessage, setDetectorMessage] = useState('');
  const [configs, setConfigs] = useState<Record<ProductId, ProductConfig>>(() => loadProductConfigs());
  const [selectedProduct, setSelectedProduct] = useState<ProductId>('product1');
  const [normalizedView, setNormalizedView] = useState<NormalizedView | null>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [inspectionMessage, setInspectionMessage] = useState('');
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [debugMode, setDebugMode] = useState(true);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  useEffect(() => {
    const supported = Boolean(navigator.mediaDevices && window.Worker && window.isSecureContext);
    setBrowserSupported(supported);
    if (!supported) {
      setDetectorState('error');
      setDetectorMessage(window.isSecureContext ? 'This browser does not expose a camera interface.' : 'Camera access requires a secure browser context (HTTPS or localhost).');
      return;
    }
    const worker = new Worker(`${import.meta.env.BASE_URL}detector/worker.js`);
    workerRef.current = worker;
    worker.onmessage = (event: MessageEvent<{ type: string; detections?: Detection[]; message?: string }>) => {
      if (event.data.type === 'ready') {
        setDetectorState('ready');
        setDetectorMessage('');
      } else if (event.data.type === 'detections') {
        setDetections(event.data.detections ?? []);
        setIsDetecting(false);
      } else if (event.data.type === 'error') {
        setDetectorState('error');
        setDetectorMessage(event.data.message ?? 'The detector could not be initialized.');
        setIsDetecting(false);
      }
    };
    worker.onerror = () => {
      setDetectorState('error');
      setDetectorMessage('The AprilTag detector failed to load in this browser.');
      setIsDetecting(false);
    };
    worker.postMessage({ type: 'init' });
    return () => {
      stopCamera();
      worker.terminate();
      workerRef.current = null;
    };
  }, [stopCamera]);

  useEffect(() => {
    saveProductConfigs(configs);
  }, [configs]);

  const openCamera = useCallback(async () => {
    if (!browserSupported) return;
    setCameraMessage('');
    setCameraState('opening');
    try {
      stopCamera();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      });
      streamRef.current = stream;
      if (!videoRef.current) return;
      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraState('ready');
    } catch (error) {
      setCameraState('error');
      if (error instanceof DOMException && error.name === 'NotAllowedError') {
        setCameraMessage('Camera permission was denied. Allow camera access in your browser settings, then try again.');
      } else if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError')) {
        setCameraMessage('No camera is available on this device.');
      } else {
        setCameraMessage('The camera could not be opened. Check that another app is not using it.');
      }
    }
  }, [browserSupported, stopCamera]);

  const takePhoto = useCallback(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || !video.videoWidth || cameraState !== 'ready') return;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    setCapture({ url: canvas.toDataURL('image/jpeg', .94), width: canvas.width, height: canvas.height });
    setDetections(null);
    setNormalizedView(null);
    setInspection(null);
    setInspectionMessage('');
    stopCamera();
    setCameraState('idle');
  }, [cameraState, stopCamera]);

  const detectTags = useCallback(() => {
    if (!capture || detectorState !== 'ready' || !workerRef.current || !canvasRef.current) return;
    const context = canvasRef.current.getContext('2d');
    if (!context) return;
    const pixels = context.getImageData(0, 0, capture.width, capture.height);
    const grayscale = new Uint8Array(capture.width * capture.height);
    for (let i = 0, p = 0; i < pixels.data.length; i += 4, p += 1) {
      grayscale[p] = Math.round((pixels.data[i] * 0.299) + (pixels.data[i + 1] * 0.587) + (pixels.data[i + 2] * 0.114));
    }
    setIsDetecting(true);
    workerRef.current.postMessage({ type: 'detect', pixels: grayscale.buffer, width: capture.width, height: capture.height }, [grayscale.buffer]);
  }, [capture, detectorState]);

  const createNormalizedView = useCallback(() => {
    if (!capture || !detections || detections.length === 0 || !canvasRef.current) return;
    const missingIds = EXPECTED_IDS.filter((id) => !detections.some((detection) => detection.id === id));
    if (missingIds.length > 0) {
      setInspectionMessage(`Controle niet mogelijk — niet alle 4 referentietags zichtbaar. Missing IDs: ${missingIds.join(', ')}.`);
      setNormalizedView(null);
      setInspection(null);
      return;
    }
    const context = canvasRef.current.getContext('2d');
    if (!context) {
      setInspectionMessage('The captured frame could not be read for normalization.');
      return;
    }
    setIsNormalizing(true);
    setInspectionMessage('');
    window.setTimeout(() => {
      try {
        const source = context.getImageData(0, 0, capture.width, capture.height);
        const imageData = normalizeImage(source, detections, NORMALIZED_SIZE);
        if (!imageData) {
          setInspectionMessage('Perspective correction failed. Capture all four tags clearly and try again.');
          setNormalizedView(null);
          return;
        }
        setNormalizedView({ imageData, url: imageDataToUrl(imageData) });
        setInspection(null);
      } catch {
        setInspectionMessage('Perspective correction failed. The captured image could not be normalized.');
        setNormalizedView(null);
      } finally {
        setIsNormalizing(false);
      }
    }, 0);
  }, [capture, detections]);

  const runInspection = useCallback(() => {
    if (!normalizedView) return;
    setInspectionMessage('');
    try {
      setInspection(inspectNormalizedImage(normalizedView.imageData, configs[selectedProduct], EXPECTED_IDS));
    } catch {
      setInspectionMessage('The ROI analysis could not be completed for this frame.');
      setInspection(null);
    }
  }, [configs, normalizedView, selectedProduct]);

  const updateZone = useCallback((productId: ProductId, zoneIndex: number, field: keyof Pick<InspectionZone, 'x' | 'y' | 'w' | 'h' | 'threshold'>, value: number) => {
    const safeValue = Math.min(1, Math.max(0, value));
    setConfigs((current) => ({
      ...current,
      [productId]: {
        ...current[productId],
        zones: current[productId].zones.map((zone, index) => index === zoneIndex ? { ...zone, [field]: safeValue } : zone),
      },
    }));
    setInspection(null);
  }, []);

  const resetCalibration = useCallback(() => {
    setConfigs(resetProductConfigs());
    setInspection(null);
    setInspectionMessage('Calibration values reset to the editable defaults.');
  }, []);

  const retake = useCallback(() => {
    setCapture(null);
    setDetections(null);
    setCameraMessage('');
    setNormalizedView(null);
    setInspection(null);
    setInspectionMessage('');
    setCameraState('idle');
  }, []);

  const foundIds = useMemo(() => new Set((detections ?? []).map((item) => item.id)), [detections]);
  const resultReady = detections !== null;
  const resultDetections = detections ?? [];
  const expectedFound = EXPECTED_IDS.filter((id) => foundIds.has(id)).length;
  const missingIds = EXPECTED_IDS.filter((id) => !foundIds.has(id));

  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" data-testid="link-home">
          <span className="brand-mark" aria-hidden="true" />
          <span>AprilTag Tester <span className="brand-sub">/ FIELD TOOL</span></span>
        </a>
        <span className="header-note">LOCAL ONLY · NO IMAGE UPLOAD</span>
      </header>

      <main className="main-wrap">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <div className="eyebrow">Calibration marker verification</div>
            <h1 id="page-title">Can your camera see the set?</h1>
            <p>Capture one frame of the printed markers. AprilTag Tester checks for the four expected IDs without sending the image anywhere.</p>
          </div>
          <div className="hero-figure" aria-hidden="true">
            <div className="tag-grid">
              <span className="tag-mini" /><span className="tag-mini" /><span className="tag-mini" /><span className="tag-mini" />
            </div>
          </div>
        </section>

        {!browserSupported && (
          <div className="message error" data-testid="status-unsupported-browser">
            <CircleHelp size={16} />
            <span><strong>Unsupported browser.</strong> {detectorMessage}</span>
          </div>
        )}

        <div className="workspace">
          <section className="panel camera-panel" aria-labelledby="camera-title">
            <div className="panel-header">
              <div className="panel-title" id="camera-title"><Camera size={15} style={{ verticalAlign: '-2px', marginRight: 8 }} /> Capture frame</div>
              <span className="panel-code">{capture ? `${capture.width} × ${capture.height} PX` : 'AWAITING FRAME'}</span>
            </div>
            <div className="camera-stage" data-testid="camera-stage">
              {!capture && <video ref={videoRef} playsInline muted style={{ display: cameraState === 'ready' ? 'block' : 'none' }} data-testid="video-camera" />}
              {capture && (
                <>
                  <img className="capture-img" src={capture.url} alt="Captured camera frame ready for AprilTag detection" data-testid="img-captured-frame" />
                  {detections && (
                    <svg className="overlay-svg" viewBox={`0 0 ${capture.width} ${capture.height}`} preserveAspectRatio="xMidYMid meet" data-testid="overlay-detections">
                      {detections.map((detection) => {
                        const points = detection.corners.map((corner) => `${corner.x},${corner.y}`).join(' ');
                        const center = detection.center ?? detection.corners.reduce((acc, corner) => ({ x: acc.x + corner.x / 4, y: acc.y + corner.y / 4 }), { x: 0, y: 0 });
                        return (
                          <g key={`${detection.id}-${center.x}-${center.y}`}>
                            <polygon className="overlay-tag" points={points} />
                            <text className="overlay-label" x={center.x + 10} y={center.y - 10}>ID {detection.id}</text>
                          </g>
                        );
                      })}
                    </svg>
                  )}
                </>
              )}
              {cameraState !== 'ready' && !capture && (
                <div className="stage-empty">
                  <span className="stage-corner tl" /><span className="stage-corner tr" /><span className="stage-corner bl" /><span className="stage-corner br" />
                  <Crosshair size={29} strokeWidth={1.4} />
                  <strong>{cameraState === 'opening' ? 'Opening camera…' : 'Camera is standing by'}</strong>
                  <span>Keep all four markers inside the frame</span>
                </div>
              )}
              {cameraState === 'ready' && <span className="stage-label">LIVE VIEW · REAR CAMERA</span>}
              {capture && <span className="stage-label">CAPTURED FRAME · {capture.width} × {capture.height}</span>}
            </div>
            <canvas ref={canvasRef} hidden data-testid="canvas-capture" />
            {isDetecting && <div className="loading-bar" data-testid="status-detecting" />}
            {cameraMessage && (
              <div className="message error" data-testid="status-camera-error">
                <AlertTriangle size={16} />
                <span>{cameraMessage}</span>
              </div>
            )}
            {capture && !isDetecting && detections === null && (
              <div className="capture-info" data-testid="text-capture-info">Full-resolution frame held locally · ready to inspect</div>
            )}
            <div className="camera-actions">
              <div className="action-group">
                {!capture && <button className="button button-primary" onClick={openCamera} disabled={!browserSupported || cameraState === 'opening'} data-testid="button-open-camera">
                  {cameraState === 'opening' ? <LoaderCircle size={15} className="spin" /> : <Camera size={15} />} {cameraState === 'opening' ? 'Opening…' : 'Open camera'}
                </button>}
                {cameraState === 'ready' && <button className="button button-primary" onClick={takePhoto} data-testid="button-take-photo"><ScanLine size={15} /> Take photo</button>}
                {capture && <button className="button button-quiet" onClick={retake} disabled={isDetecting} data-testid="button-retake"><RotateCcw size={15} /> Retake</button>}
              </div>
              {capture && <button className="button button-primary" onClick={detectTags} disabled={detectorState !== 'ready' || isDetecting} data-testid="button-detect-tags">
                {isDetecting ? <LoaderCircle size={15} /> : <Crosshair size={15} />} {isDetecting ? 'Detecting…' : 'Detect AprilTags'}
              </button>}
            </div>
          </section>

          <aside className="right-stack">
            <section className="panel system-card" aria-labelledby="system-title">
              <h2 id="system-title">System status</h2>
              <div className="system-row" data-testid="status-browser">
                <label>Browser camera API</label>
                <span className={`system-value ${browserSupported ? 'good' : 'bad'}`}><StatusDot state={browserSupported ? 'ready' : 'error'} />{browserSupported ? 'Supported' : 'Unavailable'}</span>
              </div>
              <div className="system-row" data-testid="status-camera">
                <label>Rear camera</label>
                <span className={`system-value ${cameraState === 'ready' ? 'good' : cameraState === 'error' ? 'bad' : ''}`}><StatusDot state={cameraState === 'ready' ? 'ready' : cameraState === 'error' ? 'error' : 'idle'} />{cameraState === 'ready' ? 'Live' : cameraState === 'error' ? 'Error' : 'Not open'}</span>
              </div>
              <div className="system-row" data-testid="status-detector">
                <label>Detector / tag36h11</label>
                <span className={`system-value ${detectorState === 'ready' ? 'good' : detectorState === 'error' ? 'bad' : ''}`}><StatusDot state={detectorState === 'ready' ? 'ready' : detectorState === 'error' ? 'error' : 'idle'} />{detectorState === 'checking' ? 'Loading…' : detectorState === 'ready' ? 'Ready' : 'Failed'}</span>
              </div>
              {detectorMessage && detectorState === 'error' && <div className="message error" style={{ margin: '15px 0 0' }} data-testid="status-detector-error">
                <AlertTriangle size={15} />
                <span>{detectorMessage} <button className="button button-quiet" style={{ minHeight: 28, padding: '0 8px', marginLeft: 4, fontSize: 10 }} onClick={() => { setDetectorState('checking'); setDetectorMessage(''); workerRef.current?.postMessage({ type: 'init' }); }} data-testid="button-retry-detector">Retry</button></span>
              </div>}
            </section>

            <section className="panel setup-card" aria-labelledby="setup-title">
              <h2 id="setup-title">Expected setup</h2>
              {EXPECTED_IDS.map((id, index) => (
                <div className="setup-line" key={id} data-testid={`setup-tag-${id}`}>
                  <span className="setup-index">{id}</span>
                  <div><strong>{POSITION_LABELS[index]}</strong><span>Expected tag ID {id}</span></div>
                </div>
              ))}
              <div className="setup-foot"><Info size={13} style={{ verticalAlign: '-2px', marginRight: 5 }} />tag36h11 · black area 40 × 40 mm · retain the white border in frame</div>
            </section>
          </aside>

          {resultReady && (
            <section className="panel result-panel" aria-labelledby="result-title">
              <div className="result-header">
                <div>
                  <h2 id="result-title">Detection result</h2>
                  <p data-testid="text-result-summary">
                    {expectedFound}/4 tags found
                    {expectedFound > 0 && <> · Detected: {EXPECTED_IDS.filter((id) => foundIds.has(id)).join(', ')}</>}
                    {missingIds.length > 0 && <> · Missing: {missingIds.join(', ')}</>}
                    {resultDetections.length > expectedFound && ` · ${resultDetections.length - expectedFound} other ID${resultDetections.length - expectedFound === 1 ? '' : 's'} in frame`}
                  </p>
                </div>
                <span className={`result-pill ${expectedFound === 0 ? 'none' : ''}`} data-testid="status-result">
                  {expectedFound === 4 ? <Check size={13} /> : <AlertTriangle size={13} />}
                  {expectedFound === 4 ? 'All expected IDs detected' : expectedFound === 0 ? 'No expected tags found' : 'Some expected tags missing'}
                </span>
              </div>
              <div className="tag-status-grid">
                {EXPECTED_IDS.map((id, index) => {
                  const detected = foundIds.has(id);
                  return (
                    <div className="tag-status" key={id} data-testid={`card-tag-${id}`}>
                      <div className="tag-status-top">
                        <span className="tag-id">TAG {id}</span>
                        <span className={`tag-status-symbol ${detected ? 'detected' : 'missing'}`} aria-label={detected ? `Tag ${id} detected` : `Tag ${id} missing`}>{detected ? '✓' : '—'}</span>
                      </div>
                      <p>{detected ? `Detected · ${POSITION_LABELS[index]}` : 'Not detected in frame'}</p>
                    </div>
                  );
                })}
              </div>
              {resultDetections.length === 0 && <div className="empty-result" data-testid="status-no-tags">No AprilTags were detected. Try more even lighting, move closer, and keep the white border visible.</div>}
              {expectedFound < 4 && <div className="message error inspection-unavailable" data-testid="status-inspection-unavailable">
                <AlertTriangle size={15} />
                <span><strong>Controle niet mogelijk — niet alle 4 referentietags zichtbaar.</strong> Missing IDs: {missingIds.join(', ')}.</span>
              </div>}
              {expectedFound === 4 && !normalizedView && <div className="normalize-callout" data-testid="normalize-callout">
                <div><Target size={17} /><span><strong>All four reference tags are visible.</strong><small>Create the fixed 800 × 800 top view before starting the inspection.</small></span></div>
                <button className="button button-primary" onClick={createNormalizedView} disabled={isNormalizing} data-testid="button-normalize">
                  {isNormalizing ? <LoaderCircle size={15} className="spin" /> : <WandSparkles size={15} />} {isNormalizing ? 'Normalizing…' : 'Create top view'}
                </button>
              </div>}
              <details className="debug-panel" data-testid="panel-debug">
                <summary className="debug-summary">RAW DETECTIONS · {resultDetections.length} {resultDetections.length === 1 ? 'ID' : 'IDS'}</summary>
                <div className="debug-body">
                  {resultDetections.length === 0 && <span>No raw detections returned.</span>}
                  {resultDetections.map((detection) => (
                    <div className="debug-row" key={`debug-${detection.id}-${detection.corners[0]?.x}`}>
                      <span className="debug-key">ID {detection.id}</span>
                      <span>{detection.corners.map((corner) => `(${corner.x.toFixed(1)}, ${corner.y.toFixed(1)})`).join('  ')}</span>
                    </div>
                  ))}
                </div>
              </details>
            </section>
          )}

          {normalizedView && expectedFound === 4 && (
            <section className="panel inspection-panel" aria-labelledby="inspection-title">
              <div className="inspection-header">
                <div>
                  <div className="eyebrow">Stage 2 / inspection setup</div>
                  <h2 id="inspection-title">Normalized top view</h2>
                  <p>Perspective-corrected reference area · {NORMALIZED_SIZE} × {NORMALIZED_SIZE} px · all 4 AprilTags confirmed.</p>
                </div>
                <button className={`button ${debugMode ? 'button-secondary' : 'button-quiet'}`} onClick={() => setDebugMode((current) => !current)} data-testid="button-toggle-debug">
                  <SlidersHorizontal size={15} /> {debugMode ? 'Debug on' : 'Debug off'}
                </button>
              </div>

              <div className="product-selector" aria-label="Product selection">
                <div className="subsection-heading"><span>Product configuration</span><small>Choose manually for this test run</small></div>
                <div className="product-options">
                  {(Object.values(configs) as ProductConfig[]).map((product) => (
                    <button
                      key={product.id}
                      className={`product-option ${selectedProduct === product.id ? 'selected' : ''}`}
                      onClick={() => { setSelectedProduct(product.id); setInspection(null); }}
                      data-testid={`button-${product.id}`}
                    >
                      <span className="product-radio" aria-hidden="true" />
                      <span><strong>{product.name}</strong><small>{product.description}</small></span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="normalized-layout">
                <div className="normalized-preview">
                  <div className="preview-label">NORMALIZED / {configs[selectedProduct].name.toUpperCase()}</div>
                  <div className="normalized-stage" data-testid="normalized-stage">
                    <img src={normalizedView.url} alt="Perspective-corrected normalized inspection area" />
                    {debugMode && <div className="roi-overlay" aria-hidden="true">
                      {configs[selectedProduct].zones.map((zone) => {
                        const zoneResult = inspection?.zones.find((result) => result.label === zone.label);
                        return <span
                          key={zone.label}
                          className={`roi-rectangle ${zoneResult ? (zoneResult.pass ? 'pass' : 'fail') : ''}`}
                          style={{ left: `${zone.x * 100}%`, top: `${zone.y * 100}%`, width: `${zone.w * 100}%`, height: `${zone.h * 100}%` }}
                        ><b>{zone.label}</b></span>;
                      })}
                    </div>}
                  </div>
                </div>
                <div className="inspection-side">
                  <div className="side-note"><Info size={15} /><span><strong>Test thresholds</strong><small>Initial values are placeholders for calibration. They are not validated production limits.</small></span></div>
                  <button className="button button-primary inspect-button" onClick={runInspection} data-testid="button-run-inspection"><Crosshair size={16} /> Run ROI inspection</button>
                  {inspectionMessage && <div className="message error compact-message" data-testid="status-inspection-error"><AlertTriangle size={15} /><span>{inspectionMessage}</span></div>}
                </div>
              </div>

              {inspection && (
                <div className="inspection-result" data-testid="inspection-result">
                  <div className="inspection-result-header">
                    <div><h3>Inspection result</h3><p>{inspection.status === 'ok' ? 'All configured checks passed.' : 'One or more configured checks need attention.'}</p></div>
                    <span className={`inspection-status ${inspection.status === 'ok' ? 'ok' : 'nok'}`}>{inspection.status === 'ok' ? 'OK' : 'NOK'}</span>
                  </div>
                  <div className="check-grid">
                    <div className={inspection.checks.wheels ? 'check-pass' : 'check-fail'}><span>Wheels</span><b>{inspection.checks.wheels ? 'OK' : 'NOK'}</b></div>
                    <div className={inspection.checks.profiles ? 'check-pass' : 'check-fail'}><span>Profiles</span><b>{inspection.checks.profiles ? 'OK' : 'NOK'}</b></div>
                    <div className={inspection.checks.handle ? 'check-pass' : 'check-fail'}><span>Handle</span><b>{inspection.checks.handle ? 'OK' : 'NOK'}</b></div>
                  </div>
                  {inspection.errors.length > 0 && <div className="inspection-errors">{inspection.errors.map((error) => <div key={error}><AlertTriangle size={13} />{error}</div>)}</div>}
                </div>
              )}

              {debugMode && inspection && (
                <div className="roi-debug" data-testid="roi-debug">
                  <div className="subsection-heading"><span>ROI measurements</span><small>Deterministic grayscale edge analysis</small></div>
                  <div className="roi-table">
                    <div className="roi-table-row roi-table-head"><span>Zone</span><span>Edge density</span><span>Threshold</span><span>Status</span></div>
                    {inspection.zones.map((zone) => <div className="roi-table-row" key={zone.label}>
                      <span className="roi-name">{zone.label}<small>{zone.expect === 'empty' ? 'empty zone' : 'presence zone'}</small></span>
                      <span className="mono">{zone.edgeDensity.toFixed(3)}</span>
                      <span className="mono">{zone.threshold.toFixed(3)}</span>
                      <b className={zone.pass ? 'table-pass' : 'table-fail'}>{zone.pass ? 'OK' : 'NOK'}</b>
                    </div>)}
                  </div>
                </div>
              )}

              <details className="calibration-block" open data-testid="calibration-panel">
                <summary><span><SlidersHorizontal size={14} /> Calibration values</span><small>Saved locally on this device</small></summary>
                <div className="calibration-intro">Edit percentages between 0 and 1. These are one shared configuration per product and are saved automatically in local storage.</div>
                <div className="calibration-list">
                  {configs[selectedProduct].zones.map((zone, index) => <div className="calibration-row" key={zone.label}>
                    <div className="calibration-zone"><strong>{zone.label}</strong><small>{zone.expect === 'empty' ? 'must stay quiet' : 'object should be present'}</small></div>
                    {(['x', 'y', 'w', 'h', 'threshold'] as const).map((field) => <label key={field}><span>{field}</span><input type="number" min="0" max="1" step="0.01" value={zone[field]} onChange={(event) => updateZone(selectedProduct, index, field, Number(event.target.value))} /></label>)}
                  </div>)}
                </div>
                <button className="button button-quiet reset-calibration" onClick={resetCalibration} data-testid="button-reset-calibration"><RotateCcw size={14} /> Reset calibration</button>
              </details>
            </section>
          )}
        </div>

        <footer style={{ display: 'flex', justifyContent: 'space-between', gap: 18, paddingTop: 24, color: 'hsl(var(--muted-foreground))', fontSize: 10 }}>
          <span className="mono" data-testid="text-footer-family">FAMILY: TAG36H11 / IDS: 0—3</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}><ShieldCheck size={13} /> Processed in this browser</span>
        </footer>
      </main>
    </div>
  );
}

export default App;
