importScripts('apriltag_wasm.js');

let moduleInstance;
let detectFn;
let setBuffer;
let setOptions;
let setTagSize;

function boot() {
  return AprilTagWasm().then((module) => {
    moduleInstance = module;
    detectFn = module.cwrap('atagjs_detect', 'number', []);
    setBuffer = module.cwrap('atagjs_set_img_buffer', 'number', ['number', 'number', 'number']);
    setOptions = module.cwrap('atagjs_set_detector_options', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
    setTagSize = module.cwrap('atagjs_set_tag_size', null, ['number', 'number']);
    const init = module.cwrap('atagjs_init', 'number', []);
    init();
    setOptions(2.0, 0.0, 1, 1, 0, 0, 0);
    [0, 1, 2, 3].forEach((id) => setTagSize(id, 0.04));
    self.postMessage({ type: 'ready' });
  }).catch((error) => {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'The detector could not be initialized.' });
  });
}

function readDetections(pointer) {
  const length = moduleInstance.getValue(pointer, 'i32');
  if (!length) return [];
  const stringPointer = moduleInstance.getValue(pointer + 4, 'i32');
  const bytes = new Uint8Array(moduleInstance.HEAP8.buffer, stringPointer, length);
  return JSON.parse(new TextDecoder().decode(bytes));
}

self.onmessage = async (event) => {
  const message = event.data;
  if (message.type === 'init') {
    await boot();
    return;
  }
  if (message.type === 'detect' && moduleInstance) {
    try {
      const { pixels, width, height } = message;
      const buffer = setBuffer(width, height, width);
      moduleInstance.HEAPU8.set(new Uint8Array(pixels), buffer);
      const detections = readDetections(detectFn());
      self.postMessage({ type: 'detections', detections });
    } catch (error) {
      self.postMessage({ type: 'error', message: error instanceof Error ? error.message : 'Detection failed.' });
    }
  }
};