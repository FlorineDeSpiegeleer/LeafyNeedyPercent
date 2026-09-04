import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronRight,
  ImagePlus,
  LoaderCircle,
  LockKeyhole,
  RotateCcw,
  ScanLine,
  Trash2,
  X,
} from 'lucide-react';

import {
  NORMALIZED_HEIGHT,
  NORMALIZED_WIDTH,
  PRODUCT_ZONES,
  REFERENCE_STORAGE_KEYS,
  type Detection,
  type InspectionResult,
  type ProductId,
  compareProductWithReference,
  dataUrlToImageData,
  imageDataToUrl,
  normalizeImage,
} from '@/lib/inspection';

type CameraState = 'idle' | 'opening' | 'ready' | 'error';
type DetectorState = 'checking' | 'ready' | 'error';
type CaptureMode = 'reference' | 'inspection';

type Capture = { url: string; width: number; height: number };
type ReferenceData = { url: string; imageData: ImageData };

const EXPECTED_IDS = [0, 1, 2, 3];
const SETUP_PIN = '9999';

function productName(product: ProductId) {
  return product === 'product1' ? 'Product 1' : 'Product 2';
}

export default function App() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const workerRef = useRef<Worker | null>(null);

  const captureModeRef = useRef<CaptureMode>('inspection');
  const productRef = useRef<ProductId>('product1');
  const referencesRef = useRef<Partial<Record<ProductId, ReferenceData>>>({});
  const processDetectionsRef = useRef<(found: Detection[]) => void>(() => {});

  const setupRequested = useMemo(
    () => new URLSearchParams(window.location.search).get('setup') === '1',
    [],
  );

  const [page, setPage] = useState<'setup' | 'control'>(setupRequested ? 'setup' : 'control');
  const [setupUnlocked, setSetupUnlocked] = useState(false);
  const [pin, setPin] = useState('');
  const [pinError, setPinError] = useState(false);

  const [selectedProduct, setSelectedProduct] = useState<ProductId>('product1');
  const [captureMode, setCaptureMode] = useState<CaptureMode>('inspection');
  const [references, setReferences] = useState<Partial<Record<ProductId, ReferenceData>>>({});
  const [referencesLoading, setReferencesLoading] = useState(true);

  const [cameraState, setCameraState] = useState<CameraState>('idle');
  const [detectorState, setDetectorState] = useState<DetectorState>('checking');
  const [capture, setCapture] = useState<Capture | null>(null);
  const [detections, setDetections] = useState<Detection[] | null>(null);
  const [normalizedUrl, setNormalizedUrl] = useState<string | null>(null);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  const [showZones, setShowZones] = useState(false);

  const browserSupported = Boolean(
    navigator.mediaDevices?.getUserMedia && window.Worker && window.isSecureContext,
  );

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    setCameraState('idle');
  }, []);

  const clearCapture = useCallback(() => {
    stopCamera();
    setCapture(null);
    setDetections(null);
    setNormalizedUrl(null);
    setInspection(null);
    setBusy(false);
    setMessage('');
    setSuccessMessage('');
  }, [stopCamera]);

  // Load both product references from localStorage once.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const next: Partial<Record<ProductId, ReferenceData>> = {};

      for (const product of ['product1', 'product2'] as ProductId[]) {
        try {
          const saved = localStorage.getItem(REFERENCE_STORAGE_KEYS[product]);
          if (!saved) continue;
          next[product] = { url: saved, imageData: await dataUrlToImageData(saved) };
        } catch {
          localStorage.removeItem(REFERENCE_STORAGE_KEYS[product]);
        }
      }

      if (!cancelled) {
        referencesRef.current = next;
        setReferences(next);
        setReferencesLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, []);

  // AprilTag worker stays exactly local/WASM.
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
        processDetectionsRef.current(found);
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
  }, [browserSupported]);

  const openCamera = useCallback(async (mode: CaptureMode, product: ProductId) => {
    clearCapture();
    captureModeRef.current = mode;
    productRef.current = product;
    setCaptureMode(mode);
    setSelectedProduct(product);
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

      // The camera panel is rendered already in the "opening" state.
      // Wait one animation frame so <video ref={videoRef}> is definitely mounted.
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

      if (!videoRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
        setCameraState('error');
        setMessage('Cameraweergave kon niet worden opgebouwd. Probeer opnieuw.');
        return;
      }

      videoRef.current.srcObject = stream;
      await videoRef.current.play();
      setCameraState('ready');
    } catch {
      setCameraState('error');
      setMessage('Camera kon niet geopend worden. Controleer de cameratoestemming.');
    }
  }, [clearCapture]);

  const detectTags = useCallback((width: number, height: number) => {
    if (!canvasRef.current || !workerRef.current || detectorState !== 'ready') {
      setBusy(false);
      setMessage('AprilTag detector is nog niet klaar.');
      return;
    }

    const context = canvasRef.current.getContext('2d');
    if (!context) return;
    const image = context.getImageData(0, 0, width, height);
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
    const context = canvas.getContext('2d');
    if (!context) return;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    const photo = {
      url: canvas.toDataURL('image/jpeg', 0.94),
      width: canvas.width,
      height: canvas.height,
    };

    setCapture(photo);
    setDetections(null);
    setNormalizedUrl(null);
    setInspection(null);
    setMessage('');
    setSuccessMessage('');
    setBusy(true);
    stopCamera();

    window.setTimeout(() => detectTags(photo.width, photo.height), 0);
  }, [detectTags, stopCamera]);

  const processDetections = useCallback((found: Detection[]) => {
    const missing = EXPECTED_IDS.filter((id) => !found.some((d) => d.id === id));
    if (missing.length) {
      setBusy(false);
      setMessage(`Controle niet mogelijk — ${4 - missing.length}/4 tags gevonden. Ontbrekend: ${missing.join(', ')}.`);
      return;
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    try {
      const source = context.getImageData(0, 0, canvas.width, canvas.height);
      const normalized = normalizeImage(source, found, NORMALIZED_WIDTH, NORMALIZED_HEIGHT);
      if (!normalized) throw new Error('normalize failed');

      const url = imageDataToUrl(normalized, 0.94);
      setNormalizedUrl(url);

      const product = productRef.current;

      if (captureModeRef.current === 'reference') {
        // Important: save FIRST to localStorage, then update ref + React state immediately.
        localStorage.setItem(REFERENCE_STORAGE_KEYS[product], url);
        const next = {
          ...referencesRef.current,
          [product]: { url, imageData: normalized },
        };
        referencesRef.current = next;
        setReferences(next);
        setInspection(null);
        setBusy(false);
        setMessage('');
        setSuccessMessage(`${productName(product)} is opgeslagen als correcte referentie.`);
        return;
      }

      const reference = referencesRef.current[product];
      if (!reference) {
        setBusy(false);
        setMessage(`Geen referentie voor ${productName(product)}. Contacteer de beheerder.`);
        return;
      }

      const result = compareProductWithReference(product, normalized, reference.imageData, EXPECTED_IDS);
      setInspection(result);
      setBusy(false);
      setMessage('');
    } catch (error) {
      console.error(error);
      setBusy(false);
      setInspection(null);
      setMessage('De foto kon niet verwerkt worden. Neem een nieuwe foto.');
    }
  }, []);

  processDetectionsRef.current = processDetections;

  const deleteReference = useCallback((product: ProductId) => {
    localStorage.removeItem(REFERENCE_STORAGE_KEYS[product]);
    const next = { ...referencesRef.current };
    delete next[product];
    referencesRef.current = next;
    setReferences(next);
    clearCapture();
    setSuccessMessage(`${productName(product)} referentie verwijderd.`);
  }, [clearCapture]);

  const unlockSetup = () => {
    if (pin === SETUP_PIN) {
      setSetupUnlocked(true);
      setPinError(false);
    } else {
      setPinError(true);
    }
  };

  const goToControl = () => {
    clearCapture();
    setPage('control');
    window.history.replaceState({}, '', window.location.pathname);
  };

  const foundIds = useMemo(
    () => new Set((detections ?? []).map((d) => d.id)),
    [detections],
  );

  // Hidden admin/setup page, only via ?setup=1 + PIN.
  if (page === 'setup' && !setupUnlocked) {
    return (
      <div className="dw-app">
        <header className="dw-header">
          <div>
            <p className="dw-eyebrow">BEHEER · REFERENTIE-INSTELLING</p>
            <h1>Productreferenties</h1>
          </div>
        </header>

        <main className="dw-main">
          <section className="pin-card">
            <div className="pin-icon"><LockKeyhole size={34} /></div>
            <h2>Beheerderstoegang</h2>
            <p>Deze pagina is niet bereikbaar vanuit de operatorcontrole.</p>
            <input
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              placeholder="PIN"
              onChange={(e) => { setPin(e.target.value); setPinError(false); }}
              onKeyDown={(e) => { if (e.key === 'Enter') unlockSetup(); }}
            />
            {pinError && <div className="dw-error"><AlertTriangle size={18} />Onjuiste PIN</div>}
            <button className="primary-action" onClick={unlockSetup}>
              <LockKeyhole size={20} /> Beheer openen
            </button>
          </section>
        </main>
      </div>
    );
  }

  if (page === 'setup') {
    return (
      <div className="dw-app">
        <header className="dw-header">
          <div>
            <p className="dw-eyebrow">BEHEER · REFERENTIE-INSTELLING</p>
            <h1>Correcte referenties</h1>
          </div>
        </header>

        <main className="dw-main">
          <section className="dw-info">
            <Check size={22} />
            <div>
              <strong>Eenmalige kalibratie</strong>
              <p>Maak één correcte 810 × 650 referentie voor Product 1 en één voor Product 2. Daarna hoeven ze niet opnieuw gemaakt te worden.</p>
            </div>
          </section>

          <div className="setup-products-grid">
            {(['product1', 'product2'] as ProductId[]).map((product) => {
              const ref = references[product];
              return (
                <section className="reference-card" key={product}>
                  <div className="reference-card-heading">
                    <div>
                      <p className="small-label">CORRECTE REFERENTIE</p>
                      <h2>{productName(product)}</h2>
                      <p>{product === 'product1' ? 'Met handvat' : 'Zonder handvat'}</p>
                    </div>
                    <span className={`reference-status ${ref ? 'ready' : 'missing'}`}>
                      {ref ? <><Check size={16}/> OPGESLAGEN</> : <><AlertTriangle size={16}/> NOG NODIG</>}
                    </span>
                  </div>

                  {ref && (
                    <div className="reference-preview">
                      <img src={ref.url} alt={`${productName(product)} referentie`} />
                      <div><strong>{productName(product)}</strong><span>810 × 650 px · lokaal bewaard</span></div>
                    </div>
                  )}

                  <div className="reference-actions">
                    <button className="reference-action primary" onClick={() => openCamera('reference', product)} disabled={detectorState !== 'ready'}>
                      <ImagePlus size={18}/> {ref ? 'Nieuwe referentie' : 'Referentie opnemen'}
                    </button>
                    {ref && <button className="reference-action danger" onClick={() => deleteReference(product)}><Trash2 size={18}/> Verwijderen</button>}
                  </div>
                </section>
              );
            })}
          </div>

          {(cameraState === 'opening' || cameraState === 'ready' || capture) && (
            <CameraPanel
              mode="reference" product={selectedProduct} cameraState={cameraState}
              capture={capture} busy={busy} detections={detections} foundIds={foundIds}
              normalizedUrl={normalizedUrl} inspection={null} reference={references[selectedProduct]}
              showZones={showZones} setShowZones={setShowZones}
              videoRef={videoRef} canvasRef={canvasRef} onTakePhoto={takePhoto} onReset={clearCapture}
            />
          )}

          {message && <div className="dw-error"><AlertTriangle size={20}/>{message}</div>}
          {successMessage && <div className="dw-success"><Check size={20}/>{successMessage}</div>}

          <button className="continue-action" onClick={goToControl} disabled={!references.product1 || !references.product2}>
            Naar productcontrole <ChevronRight size={20}/>
          </button>
          {(!references.product1 || !references.product2) && <p className="setup-hint">Stel eerst beide producten in.</p>}
        </main>
      </div>
    );
  }

  // Normal operator control page. No setup/edit/delete buttons anywhere here.
  return (
    <div className="dw-app">
      <header className="dw-header">
        <div>
          <p className="dw-eyebrow">CAMERA · EINDCONTROLE</p>
          <h1>Productcontrole</h1>
        </div>
      </header>

      <main className="dw-main">
        <section className="dw-info">
          <ScanLine size={22}/>
          <div>
            <strong>Kies Product 1 of Product 2</strong>
            <p>De referentie is vooraf door de beheerder ingesteld en kan hier niet gewijzigd worden.</p>
          </div>
        </section>

        <div className="product-selector">
          {(['product1', 'product2'] as ProductId[]).map((product) => (
            <button
              key={product}
              className={`product-select-card ${selectedProduct === product ? 'active' : ''}`}
              onClick={() => {
                clearCapture();
                productRef.current = product;
                setSelectedProduct(product);
              }}
            >
              <span className="product-number">{product === 'product1' ? '01' : '02'}</span>
              <div><strong>{productName(product)}</strong><small>{product === 'product1' ? 'Met handvat' : 'Zonder handvat'}</small></div>
              <span className={`mini-status ${references[product] ? 'ready' : 'missing'}`}>
                {references[product] ? 'REFERENTIE OK' : 'GEEN REFERENTIE'}
              </span>
            </button>
          ))}
        </div>

        {!referencesLoading && !references[selectedProduct] && (
          <div className="dw-error"><AlertTriangle size={20}/>Geen referentie voor {productName(selectedProduct)}. Contacteer de beheerder.</div>
        )}

        {!capture && cameraState !== 'ready' && (
          <button
            className="primary-action"
            disabled={!references[selectedProduct] || detectorState !== 'ready' || cameraState === 'opening'}
            onClick={() => openCamera('inspection', selectedProduct)}
          >
            {cameraState === 'opening' ? <LoaderCircle size={22} className="spin"/> : <Camera size={22}/>} Camera openen voor {productName(selectedProduct)}
          </button>
        )}

        {(cameraState === 'opening' || cameraState === 'ready' || capture) && (
          <CameraPanel
            mode="inspection" product={selectedProduct} cameraState={cameraState}
            capture={capture} busy={busy} detections={detections} foundIds={foundIds}
            normalizedUrl={normalizedUrl} inspection={inspection} reference={references[selectedProduct]}
            showZones={showZones} setShowZones={setShowZones}
            videoRef={videoRef} canvasRef={canvasRef} onTakePhoto={takePhoto} onReset={clearCapture}
          />
        )}

        {message && <div className="dw-error"><AlertTriangle size={20}/>{message}</div>}
      </main>
    </div>
  );
}

function CameraPanel({
  mode, product, cameraState, capture, busy, detections, foundIds,
  normalizedUrl, inspection, reference, showZones, setShowZones,
  videoRef, canvasRef, onTakePhoto, onReset,
}: {
  mode: CaptureMode;
  product: ProductId;
  cameraState: CameraState;
  capture: Capture | null;
  busy: boolean;
  detections: Detection[] | null;
  foundIds: Set<number>;
  normalizedUrl: string | null;
  inspection: InspectionResult | null;
  reference: ReferenceData | undefined;
  showZones: boolean;
  setShowZones: (value: boolean) => void;
  videoRef: React.RefObject<HTMLVideoElement>;
  canvasRef: React.RefObject<HTMLCanvasElement>;
  onTakePhoto: () => void;
  onReset: () => void;
}) {
  return (
    <section className="camera-card">
      <div className="capture-mode-bar">
        <span className={`capture-mode-pill ${mode}`}>{mode === 'reference' ? 'REFERENTIE' : 'CONTROLE'} · {productName(product).toUpperCase()}</span>
      </div>

      <div className="camera-stage">
        {!capture && <video ref={videoRef} autoPlay playsInline muted className={cameraState === 'ready' ? 'camera-video visible' : 'camera-video'} />}
        {capture && <img src={capture.url} className="camera-photo" alt="Genomen foto" />}

        {cameraState === 'opening' && !capture && (
          <div className="processing-overlay">
            <LoaderCircle size={48} className="spin"/>
            <strong>Camera openen…</strong>
            <span>Even geduld</span>
          </div>
        )}

        {cameraState === 'ready' && !capture && <><div className="live-pill">● LIVE</div><div className="guide-frame"><span>ALLE 4 TAGS VOLLEDIG IN BEELD</span></div></>}

        {busy && <div className="processing-overlay"><LoaderCircle size={48} className="spin"/><strong>{mode === 'reference' ? 'Referentie opslaan…' : 'Product vergelijken…'}</strong><span>AprilTags → 810 × 650 → {mode === 'reference' ? 'localStorage' : 'referentiematch'}</span></div>}
      </div>

      <canvas ref={canvasRef} hidden />

      {!capture && cameraState === 'ready' && <button className="primary-action" onClick={onTakePhoto}><Camera size={21}/>{mode === 'reference' ? 'Foto nemen en opslaan' : 'Foto nemen en controleren'}</button>}
      {capture && !busy && <button className="secondary-action" onClick={onReset}><RotateCcw size={19}/>Nieuwe foto</button>}

      {detections && (
        <div className="tag-status-card">
          <div className="card-title-row"><div><p className="small-label">APRILTAGS</p><h2>{EXPECTED_IDS.filter((id) => foundIds.has(id)).length}/4 gevonden</h2></div></div>
          <div className="tag-chips">{EXPECTED_IDS.map((id) => <span key={id} className={foundIds.has(id) ? 'tag-chip found' : 'tag-chip missing'}>ID {id} {foundIds.has(id) ? '✓' : '×'}</span>)}</div>
        </div>
      )}

      {normalizedUrl && mode === 'reference' && (
        <div className="normalized-section"><p className="small-label">OPGESLAGEN GENORMALISEERDE REFERENTIE</p><div className="normalized-stage"><img src={normalizedUrl} alt="Referentie"/></div></div>
      )}

      {normalizedUrl && inspection && mode === 'inspection' && (
        <div className="result-card">
          <div className={`result-banner ${inspection.status === 'ok' ? 'ok' : 'nok'}`}>
            <div className="result-icon">{inspection.status === 'ok' ? <Check size={32}/> : <X size={32}/>}</div>
            <div><p className="small-label">{productName(product).toUpperCase()}</p><h2>{inspection.status === 'ok' ? 'Product goedgekeurd' : 'Afwijking gedetecteerd'}</h2><p>Totale match: <strong>{Math.round(inspection.overallSimilarity * 100)}%</strong></p></div>
          </div>

          <div className="comparison-preview-grid">
            <div><p className="small-label">CORRECTE REFERENTIE</p><img src={reference?.url} alt="Referentie"/></div>
            <div>
              <p className="small-label">HUIDIGE FOTO</p>
              <div className="normalized-stage">
                <img src={normalizedUrl} alt="Huidige foto"/>
                {showZones && <div className="roi-overlay">{PRODUCT_ZONES[product].map((zone) => {
                  const result = inspection.zones.find((z) => z.id === zone.id);
                  return <span key={zone.id} className={`roi ${result?.pass ? 'pass' : 'fail'}`} style={{left:`${zone.x*100}%`,top:`${zone.y*100}%`,width:`${zone.w*100}%`,height:`${zone.h*100}%`}}>{zone.label} {Math.round((result?.similarity ?? 0)*100)}%</span>;
                })}</div>}
              </div>
            </div>
          </div>

          <button className="debug-toggle" onClick={() => setShowZones(!showZones)}>{showZones ? 'Zones verbergen' : 'Vergelijkingszones tonen'}</button>
          <div className="checks-grid">{inspection.zones.map((zone) => <div key={zone.id} className={`check-tile ${zone.pass ? 'pass' : 'fail'}`}><span>{zone.label}</span><b>{zone.pass ? 'OK' : 'NOK'}</b><small>{Math.round(zone.similarity*100)}% match</small></div>)}</div>
          {inspection.errors.length > 0 && <div className="error-list">{inspection.errors.map((error) => <div key={error}><AlertTriangle size={17}/>{error}</div>)}</div>}
        </div>
      )}
    </section>
  );
}
