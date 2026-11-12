/**
 * Anbarin Barcode Scanner
 * Stable camera lifecycle, Html5Qrcode/ZXing decoding first, native BarcodeDetector fallback,
 * plus USB/Bluetooth keyboard-wedge and manual entry.
 *
 * Public API intentionally matches the previous module so application flows remain unchanged.
 */

import type { AppSettings } from '@/types';
import { Capacitor } from '@capacitor/core';
import { Camera } from '@capacitor/camera';
import { toast } from './ui';
import { normalizeDigits } from '@/utils/helpers';

export type ScanSource = 'camera' | 'native' | 'html5' | 'bt' | 'manual';

export interface ScanResult {
  code: string;
  source: ScanSource;
  at: number;
}

export interface ScannerOptions {
  containerId: string;
  getSettings: () => AppSettings;
  canScan?: () => boolean;
  isQtyModalOpen?: () => boolean;
  onScan: (result: ScanResult) => void;
  onFieldFill?: (fieldId: string, code: string) => void;
}

type DetectorResult = { rawValue?: string };
type NativeDetector = {
  detect: (source: HTMLVideoElement) => Promise<DetectorResult[]>;
};

declare global {
  interface Window {
    Html5Qrcode?: any;
  }
}

let opts: ScannerOptions | null = null;
let active = false;
let quickMode = false;
let scanTargetField: string | null = null;
let generation = 0;

let html5Instance: any = null;
let html5Running = false;
let nativeStream: MediaStream | null = null;
let nativeVideo: HTMLVideoElement | null = null;
let nativeDetector: NativeDetector | null = null;
let nativeRaf = 0;
let nativeBusy = false;
let nativeLastDetectAt = 0;
let torchOn = false;

let lastScanTime = 0;
let lastScanCode = '';
// The camera remains running while the quantity dialog is open. Once the user
// confirms, allow a different barcode to be accepted almost immediately.
// The longer same-code guard remains to prevent the same visible label from
// being counted twice if it is still in front of the camera.
const GLOBAL_COOLDOWN_MS = 80;
const SAME_CODE_COOLDOWN_MS = 1100;

let btBuffer = '';
let btTimer: number | null = null;
let btListenerAttached = false;
let audioCtx: AudioContext | null = null;
let scriptLoadPromise: Promise<boolean> | null = null;
let lifecycleQueue: Promise<void> = Promise.resolve();

const BARCODE_FORMAT_NAMES = [
  'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E', 'CODE_128',
  'CODE_39', 'ITF', 'CODABAR', 'QR_CODE', 'DATA_MATRIX',
  'PDF_417', 'AZTEC',
];

export function initScanner(options: ScannerOptions): void {
  opts = options;
  attachBluetoothListener();
}

export function isScannerActive(): boolean {
  return active;
}

export function openScanner(options?: {
  targetField?: string | null;
  quick?: boolean;
  title?: string;
}): void {
  if (!opts) {
    console.warn('[scanner] initScanner must be called before openScanner');
    return;
  }

  scanTargetField = options?.targetField ?? null;
  quickMode = !!options?.quick;
  active = true;
  const token = ++generation;

  const titleEl = document.getElementById('scannerTitle');
  if (titleEl && options?.title) titleEl.textContent = options.title;

  const modal = document.getElementById('scannerModal');
  if (modal) {
    modal.classList.add('show');
    // Keep compatibility with the app's existing modal implementation.
    modal.style.display = 'flex';
    // بالاتر از برگه فاکتور / اقلام / تعریف کالا (۱۰۱۲۰–۱۰۲۰۰)
    modal.style.zIndex = '10300';
  }

  // بعد از بستن سریع/استفادهٔ دستی، همیشه اول دوربین قبلی را کامل آزاد کن سپس دوباره روشن کن
  void (async () => {
    try {
      await stopCamera();
      await delay(120);
      if (!active || token !== generation) return;

      // In Android WebView, a previous denial can leave getUserMedia blocked
      // even after the user later reopens the scanner. Re-check/request the
      // native CAMERA permission on every open instead of caching a denial.
      // The Camera plugin only handles the Android runtime permission; the
      // actual barcode stream is still owned and released by Html5Qrcode.
      if (!(await ensureCameraPermission())) {
        if (active && token === generation) {
          toast(
            'دسترسی دوربین داده نشده است. از تنظیمات برنامه، مجوز «دوربین» را فعال کنید؛ ورود دستی و بارکدخوان USB همچنان در دسترس‌اند.',
            'error'
          );
          document.getElementById('manualBarcode')?.focus();
        }
        return;
      }
      if (!active || token !== generation) return;
      await startCamera(token);
    } catch (error) {
      console.warn('[scanner] open recovery failed', error);
      if (active && token === generation) {
        toast(
          'اسکنر راه‌اندازی نشد. مجوز دوربین را بررسی کنید یا از ورود دستی/بارکدخوان USB استفاده کنید.',
          'error'
        );
        document.getElementById('manualBarcode')?.focus();
      }
    }
  })();
}

export function closeScanner(): void {
  active = false;
  generation++;
  scanTargetField = null;
  quickMode = false;
  void stopCamera();

  const modal = document.getElementById('scannerModal');
  if (modal) {
    modal.classList.remove('show');
    modal.style.display = 'none';
    modal.style.zIndex = '';
  }

  // پایان حالت اسکن فاکتور و بازگرداندن تنظیم پیوسته قبلی
  const wasInvoice = !!(window as any).__anbarinInvoiceScanActive;
  (window as any).__anbarinInvoiceScanActive = false;
  if (wasInvoice) {
    const continuous = document.getElementById('scannerContinuous') as HTMLInputElement | null;
    const before = (window as any).__anbarinScannerContinuousBeforeInvoice;
    if (continuous && typeof before === 'boolean') continuous.checked = before;
    delete (window as any).__anbarinScannerContinuousBeforeInvoice;
  }
}

export function submitManualBarcode(raw?: string): void {
  const input = document.getElementById('manualBarcode') as HTMLInputElement | null;
  const code = normalizeDigits(raw ?? input?.value ?? '').trim();
  if (!code) {
    toast('بارکد را وارد کنید', 'error');
    return;
  }
  if (input) input.value = '';
  emitScan(code, 'manual');
}

export async function toggleTorch(): Promise<void> {
  const track = nativeStream?.getVideoTracks()[0];
  if (!track) {
    toast('نور در این حالت دوربین در دسترس نیست', 'info');
    return;
  }
  try {
    const capabilities = track.getCapabilities?.() as any;
    if (!capabilities?.torch) {
      toast('این دوربین از چراغ‌قوه پشتیبانی نمی‌کند', 'info');
      return;
    }
    const next = !torchOn;
    await track.applyConstraints({ advanced: [{ torch: next }] } as any);
    torchOn = next;
    const button = document.getElementById('torchBtn');
    if (button) button.textContent = torchOn ? '🔦 خاموش' : '🔦 نور';
  } catch (error) {
    console.warn('[scanner] torch unavailable', error);
    toast('تغییر وضعیت چراغ‌قوه ممکن نشد', 'error');
  }
}

export function restartCamera(): void {
  if (!active) return;
  const token = ++generation;
  void (async () => {
    await stopCamera();
    await delay(180);
    if (active && token === generation) await startCamera(token);
  })();
}

export function playBeep(ok: boolean): void {
  if (!opts?.getSettings()?.soundOnScan) return;
  try {
    if (!audioCtx) {
      const AudioContextCtor = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioContextCtor) return;
      audioCtx = new AudioContextCtor();
    }
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const oscillator = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    oscillator.connect(gain);
    gain.connect(audioCtx.destination);
    oscillator.frequency.value = ok ? 880 : 200;
    gain.gain.value = 0.12;
    oscillator.start();
    window.setTimeout(() => {
      try { oscillator.stop(); } catch { /* already stopped */ }
    }, ok ? 75 : 140);
  } catch {
    // Audio is optional; never interrupt scanning.
  }
}

export function vibrateOnFail(): void {
  if (opts?.getSettings()?.vibrateOnScan && navigator.vibrate) {
    navigator.vibrate([45, 25, 45]);
  }
}

export function markConfirmed(code: string): void {
  lastScanCode = normalizeDigits(code).trim();
  lastScanTime = Date.now();
}


/**
 * Revalidates Android's runtime camera permission every time the scanner opens.
 * A denied result is never cached: after the user changes the permission in
 * system settings, the next open immediately proceeds to the camera startup.
 */
async function ensureCameraPermission(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return true;

  try {
    let permission = await Camera.checkPermissions();
    if (permission.camera !== 'granted') {
      permission = await Camera.requestPermissions({ permissions: ['camera'] });
    }
    return permission.camera === 'granted';
  } catch (error) {
    // Some WebView/Capacitor combinations do not expose the plugin permission
    // API. Let getUserMedia perform its normal browser permission flow there.
    console.warn('[scanner] native camera permission check unavailable', error);
    return true;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isCurrent(token: number): boolean {
  return active && token === generation;
}

function shouldAcceptScan(code: string): boolean {
  const normalized = normalizeDigits(code).trim();
  if (!normalized) return false;
  const elapsed = Date.now() - lastScanTime;
  if (normalized === lastScanCode && elapsed < SAME_CODE_COOLDOWN_MS) return false;
  if (elapsed < GLOBAL_COOLDOWN_MS) return false;
  return true;
}

function emitScan(rawCode: string, source: ScanSource): void {
  const code = normalizeDigits(rawCode).trim();
  if (!code || !opts || !shouldAcceptScan(code)) return;

  if (opts.canScan && !opts.canScan()) {
    toast('نقش مشاهده‌گر اجازه شمارش ندارد', 'error');
    return;
  }
  // Do not stop/restart the camera for the quantity dialog. Ignore decode
  // callbacks while the dialog is open; scanning becomes available again as
  // soon as the user confirms or closes it.
  if (opts.isQtyModalOpen?.()) return;

  lastScanTime = Date.now();
  lastScanCode = code;

  if (scanTargetField) {
    playBeep(true);
    opts.onFieldFill?.(scanTargetField, code);
    toast('بارکد ثبت شد', 'success');

    const continuous =
      (document.getElementById('scannerContinuous') as HTMLInputElement | null)?.checked ??
      opts.getSettings().continuousScan;
    if (!continuous) closeScanner();
    return;
  }

  opts.onScan({ code, source, at: lastScanTime });
}

function getBarcodeFormats(): number[] | undefined {
  const supported = (window as any).Html5QrcodeSupportedFormats as Record<string, number> | undefined;
  if (!supported) return undefined;
  const formats = BARCODE_FORMAT_NAMES
    .map((name) => supported[name])
    .filter((value): value is number => typeof value === 'number');
  return formats.length ? formats : undefined;
}

/**
 * The script is bundled locally in /public. Loading it on demand avoids the
 * race between deferred classic scripts and the application's module script.
 */
async function ensureHtml5Library(): Promise<boolean> {
  if (window.Html5Qrcode) return true;
  if (scriptLoadPromise) return scriptLoadPromise;

  scriptLoadPromise = new Promise<boolean>((resolve) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[src*="html5-qrcode"]'
    );
    const script = existing ?? document.createElement('script');
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok && !!window.Html5Qrcode);
    };
    const timeout = window.setTimeout(() => finish(false), 9000);

    script.addEventListener('load', () => {
      window.clearTimeout(timeout);
      finish(true);
    }, { once: true });
    script.addEventListener('error', () => {
      window.clearTimeout(timeout);
      finish(false);
    }, { once: true });

    if (!existing) {
      script.src = new URL('./html5-qrcode.min.js', document.baseURI).toString();
      script.async = true;
      document.head.appendChild(script);
    } else if (window.Html5Qrcode) {
      window.clearTimeout(timeout);
      finish(true);
    }
  }).finally(() => {
    if (!window.Html5Qrcode) scriptLoadPromise = null;
  });

  return scriptLoadPromise;
}

async function startCamera(token: number): Promise<void> {
  if (!opts || !isCurrent(token)) return;
  torchOn = false;
  const torchButton = document.getElementById('torchBtn');
  if (torchButton) torchButton.textContent = '🔦 نور';

  const host = document.getElementById(opts.containerId);
  if (!host) {
    toast('محل نمایش دوربین پیدا نشد', 'error');
    return;
  }

  // Avoid a needless asynchronous stop/clear on the first open. This removes
  // startup latency when no previous camera session exists.
  if (html5Instance || html5Running || nativeStream || nativeVideo) {
    await stopCamera();
    if (!isCurrent(token)) return;
  } else {
    stopNative();
    host.innerHTML = '';
  }

  if (!isCurrent(token)) return;
  host.innerHTML = '';
  host.setAttribute('aria-live', 'polite');

  // Html5Qrcode uses the bundled ZXing decoder and is the primary, stable
  // path on Android WebView. Do not rely on BarcodeDetector being present.
  const libraryReady = await ensureHtml5Library();
  if (!isCurrent(token)) return;

  if (libraryReady && await startHtml5(token)) return;
  if (!isCurrent(token)) return;

  if (await startNative(token)) return;
  if (!isCurrent(token)) return;

  toast(
    'اسکنر راه‌اندازی نشد. مجوز دوربین را بررسی کنید یا از ورود دستی/بارکدخوان USB استفاده کنید.',
    'error'
  );
  document.getElementById('manualBarcode')?.focus();
}

async function startHtml5(token: number): Promise<boolean> {
  if (!opts || !window.Html5Qrcode || !isCurrent(token)) return false;

  const host = document.getElementById(opts.containerId);
  if (!host) return false;

  try {
    // A fresh instance avoids stale internal state after interrupted sessions.
    if (html5Instance) {
      try {
        if (html5Running) await html5Instance.stop();
      } catch { /* ignore stale session */ }
      try { await html5Instance.clear(); } catch { /* ignore stale DOM */ }
      html5Instance = null;
      html5Running = false;
    }

    html5Instance = new window.Html5Qrcode(opts.containerId, {
      verbose: false,
      formatsToSupport: getBarcodeFormats(),
    });

    const config: Record<string, unknown> = {
      // 20 FPS gives a quicker response while remaining practical on mid-range phones.
      // No qrbox is set: decoding continues across the entire camera frame.
      fps: 20,
      disableFlip: false,
      aspectRatio: 1.7777778,
      // Match the older browser scanner's camera resolution request.
      // These are ideal values so devices can negotiate a supported mode.
      videoConstraints: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30, max: 30 },
      },
      experimentalFeatures: { useBarCodeDetectorIfSupported: false },
    };

    const onDecoded = (decodedText: string) => {
      if (!isCurrent(token) || !decodedText) return;
      emitScan(decodedText, 'html5');
    };
    const onDecodeError = () => {
      // Per-frame decode misses are normal; keep the UI quiet.
    };

    // Start directly with the rear-camera constraint. Enumerating camera
    // devices first can trigger an extra permission/device round-trip in Android
    // WebView and makes the standalone scanner feel slower than quick count.
    const cameraConfig: { facingMode: string } = { facingMode: 'environment' };

    try {
      await html5Instance.start(cameraConfig, config, onDecoded, onDecodeError);
    } catch (firstError) {
      if (!isCurrent(token)) return false;
      // Retry once with the standard environment constraint when a camera ID
      // selected by WebView is stale or rejected.
      if (typeof cameraConfig === 'string') {
        try {
          try {
            if (html5Instance?.isScanning) await html5Instance.stop();
          } catch { /* release a partially opened camera */ }
          try { await html5Instance?.clear(); } catch { /* clear stale renderer */ }
          html5Instance = new window.Html5Qrcode(opts.containerId, {
            verbose: false,
            formatsToSupport: getBarcodeFormats(),
          });
          await html5Instance.start({ facingMode: 'environment' }, config, onDecoded, onDecodeError);
        } catch (secondError) {
          console.warn('[scanner] html5 start failed', firstError, secondError);
          try {
            if (html5Instance?.isScanning) await html5Instance.stop();
            await html5Instance?.clear();
          } catch { /* ignore cleanup */ }
          html5Instance = null;
          html5Running = false;
          return false;
        }
      } else {
        console.warn('[scanner] html5 start failed, retrying alternate cameras', firstError);
        try {
          if (html5Instance?.isScanning) await html5Instance.stop();
        } catch { /* release partial */ }
        try { await html5Instance?.clear(); } catch { /* ignore */ }
        html5Instance = null;
        html5Running = false;
        if (!isCurrent(token)) return false;

        const fallbacks: Array<string | { facingMode: string } | { deviceId: { exact: string } }> = [
          { facingMode: 'environment' },
          { facingMode: 'user' },
        ];
        try {
          if (navigator.mediaDevices?.enumerateDevices) {
            const devices = await navigator.mediaDevices.enumerateDevices();
            for (const d of devices) {
              if (d.kind === 'videoinput' && d.deviceId) {
                fallbacks.push({ deviceId: { exact: d.deviceId } });
              }
            }
          }
        } catch { /* ignore enum */ }

        for (const cam of fallbacks) {
          if (!isCurrent(token)) return false;
          try {
            html5Instance = new window.Html5Qrcode(opts.containerId, {
              verbose: false,
              formatsToSupport: getBarcodeFormats(),
            });
            await html5Instance.start(cam as any, config, onDecoded, onDecodeError);
            html5Running = true;
            break;
          } catch (err) {
            console.debug('[scanner] fallback camera failed', cam, err);
            try {
              if (html5Instance?.isScanning) await html5Instance.stop();
            } catch { /* ignore */ }
            try { await html5Instance?.clear(); } catch { /* ignore */ }
            html5Instance = null;
            html5Running = false;
          }
        }
        if (!html5Running) return false;
      }
    }

    if (!isCurrent(token)) {
      try { await html5Instance.stop(); } catch { /* ignore */ }
      return false;
    }
    html5Running = true;
    // Apply continuous autofocus to the actual camera track when WebView exposes it.
    // Do not wait for this optional enhancement before enabling scanning.
    void enableContinuousAutofocus(host);
    addScanGuide();
    addScannerStatus('بارکد را داخل کادر قرار دهید؛ اسکن خارج از کادر هم فعال است');
    return true;
  } catch (error) {
    console.error('[scanner] html5 initialization failed', error);
    try {
      if (html5Instance && html5Running) await html5Instance.stop();
      if (html5Instance) await html5Instance.clear();
    } catch { /* ignore cleanup errors */ }
    html5Instance = null;
    html5Running = false;
    return false;
  }
}

async function startNative(token: number): Promise<boolean> {
  const Detector = (window as any).BarcodeDetector;
  if (!navigator.mediaDevices?.getUserMedia || !Detector || !opts) return false;

  const host = document.getElementById(opts.containerId);
  if (!host) return false;

  try {
    const supported: string[] = await Detector.getSupportedFormats();
    const preferred = [
      'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128',
      'code_39', 'itf', 'codabar', 'qr_code', 'data_matrix',
    ];
    const formats = preferred.filter((format) => supported.includes(format));
    if (!formats.length) return false;

    nativeDetector = new Detector({ formats });
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.style.cssText = 'width:100%;height:100%;display:block;object-fit:cover;background:#101817';
    host.innerHTML = '';
    host.appendChild(video);
    nativeVideo = video;
    addScanGuide();

    const constraints: MediaStreamConstraints[] = [
      { audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      { audio: false, video: { facingMode: { ideal: 'environment' } } },
      { audio: false, video: true },
    ];

    let stream: MediaStream | null = null;
    let lastError: unknown;
    for (const constraint of constraints) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(constraint);
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!stream) throw lastError || new Error('Camera unavailable');
    if (!isCurrent(token)) {
      stream.getTracks().forEach((track) => track.stop());
      return false;
    }

    nativeStream = stream;
    video.srcObject = stream;
    await video.play();
    if (!isCurrent(token)) return false;

    try {
      const track = stream.getVideoTracks()[0];
      const capabilities = track.getCapabilities?.() as any;
      if (capabilities?.focusMode?.includes('continuous')) {
        await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
      }
    } catch { /* focus mode is optional */ }

    const loop = async () => {
      if (!isCurrent(token) || !nativeVideo || !nativeDetector) return;
      nativeRaf = requestAnimationFrame(loop);
      // Limit native detection to ~10 passes/second instead of decoding every display frame.
      // This reduces CPU load without noticeably slowing barcode acquisition.
      if (nativeBusy || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return;
      const now = performance.now();
      if (now - nativeLastDetectAt < 100) return;
      nativeLastDetectAt = now;

      nativeBusy = true;
      try {
        const results = await nativeDetector.detect(video);
        if (isCurrent(token) && results?.length) {
          const value = String(results[0].rawValue || '').trim();
          if (value) emitScan(value, 'native');
        }
      } catch {
        // A frame can be undecodable while focus/exposure adjusts.
      } finally {
        nativeBusy = false;
      }
    };

    nativeRaf = requestAnimationFrame(loop);
    addScannerStatus('بارکد را داخل کادر قرار دهید؛ اسکن خارج از کادر هم فعال است');
    return true;
  } catch (error) {
    console.warn('[scanner] native fallback failed', error);
    stopNative();
    return false;
  }
}

/** Requests continuous autofocus on the active Html5Qrcode camera track. */
async function enableContinuousAutofocus(host: HTMLElement): Promise<void> {
  try {
    const video = host.querySelector('video');
    const stream = video?.srcObject as MediaStream | null;
    const track = stream?.getVideoTracks?.()[0];
    if (!track?.applyConstraints) return;
    const capabilities = track.getCapabilities?.() as any;
    if (capabilities?.focusMode?.includes('continuous')) {
      await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as any);
    }
  } catch (error) {
    // Autofocus controls are optional and vary by Android camera/WebView.
    console.debug('[scanner] continuous autofocus not available', error);
  }
}

/** Adds a visual aiming guide only; it deliberately does not crop the decode area. */
function addScanGuide(): void {
  const host = opts ? document.getElementById(opts.containerId) : null;
  if (!host || host.querySelector('.scan-guide')) return;
  const guide = document.createElement('div');
  guide.className = 'scan-guide';
  guide.setAttribute('aria-hidden', 'true');
  const frame = document.createElement('div');
  frame.className = 'scan-guide-frame';
  const label = document.createElement('div');
  label.className = 'scan-guide-label';
  label.textContent = 'بارکد را داخل کادر بگیرید';
  guide.append(frame, label);
  host.appendChild(guide);
}

function addScannerStatus(message: string): void {
  const host = opts ? document.getElementById(opts.containerId) : null;
  if (!host) return;
  let status = document.getElementById('scannerRuntimeStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'scannerRuntimeStatus';
    status.className = 'scanner-runtime-status';
    status.style.cssText =
      'position:absolute;left:8px;right:8px;bottom:8px;z-index:5;text-align:center;padding:6px 10px;border-radius:8px;background:rgba(0,0,0,.55);color:#fff;font-size:12px;pointer-events:none';
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.appendChild(status);
  }
  status.textContent = message;
}

function stopNative(): void {
  if (nativeRaf) {
    cancelAnimationFrame(nativeRaf);
    nativeRaf = 0;
  }
  if (nativeStream) {
    nativeStream.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* ignore */ }
    });
    nativeStream = null;
  }
  if (nativeVideo) {
    try { nativeVideo.pause(); } catch { /* ignore */ }
    nativeVideo.srcObject = null;
    nativeVideo = null;
  }
  nativeDetector = null;
  nativeBusy = false;
  nativeLastDetectAt = 0;
  torchOn = false;
}

async function stopHtml5(): Promise<void> {
  if (!html5Instance) {
    html5Running = false;
    return;
  }
  const inst = html5Instance;
  html5Instance = null;
  html5Running = false;
  try {
    if (inst.isScanning) await inst.stop();
  } catch (error) {
    console.debug('[scanner] html5 stop cleanup', error);
  }
  try { await inst.clear(); } catch { /* ignore */ }
}

async function stopCamera(): Promise<void> {
  // Serialize stop operations so a quick close/reopen cannot let an older
  // cleanup tear down the newly opened camera session.
  const operation = lifecycleQueue.then(async () => {
    stopNative();
    await stopHtml5();
    const host = opts ? document.getElementById(opts.containerId) : null;
    if (host) host.innerHTML = '';
  });
  lifecycleQueue = operation.catch(() => undefined);
  await operation;
}

function attachBluetoothListener(): void {
  if (btListenerAttached) return;
  btListenerAttached = true;

  document.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!opts || opts.getSettings().btScanner === false) return;
    const target = event.target as HTMLElement | null;
    const tag = (target?.tagName || '').toLowerCase();

    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      if (tag === 'input' && (target as HTMLInputElement).type === 'number') return;
      if (event.key !== 'Enter') return;
    }

    if (event.key === 'Enter') {
      if (btBuffer.length >= 3) {
        event.preventDefault();
        const code = btBuffer;
        btBuffer = '';
        if (btTimer !== null) window.clearTimeout(btTimer);
        btTimer = null;
        const status = document.getElementById('btStatus');
        if (status) status.textContent = 'اسکن شد: ' + code;
        emitScan(code, 'bt');
      } else {
        btBuffer = '';
      }
      return;
    }

    if (event.key.length === 1 && !event.ctrlKey && !event.altKey && !event.metaKey) {
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      btBuffer += event.key;
      if (btTimer !== null) window.clearTimeout(btTimer);
      btTimer = window.setTimeout(() => { btBuffer = ''; }, 140);
    }
  });
}

export function getScannerCapabilities(): {
  mediaDevices: boolean;
  barcodeDetector: boolean;
  html5Qrcode: boolean;
} {
  return {
    mediaDevices: !!navigator.mediaDevices?.getUserMedia,
    barcodeDetector: typeof (window as any).BarcodeDetector !== 'undefined',
    html5Qrcode: typeof window.Html5Qrcode !== 'undefined',
  };
}
