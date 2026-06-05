/* ── SignalInk · script.js ── */

const $ = id => document.getElementById(id);

// ── State ──────────────────────────────────────────────
let audioCtx   = null;
let analyser   = null;
let isListening = false;
let isSending   = false;
let byteAccum   = [];
let syncState   = 'idle';   // 'idle' | 'data'
let receiveBuffer = [];
let lastBitTime  = 0;
let scopeFrame   = null;
let micEnabled   = false;

// ── Audio context (lazy) ───────────────────────────────
function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

// ── Read sliders ────────────────────────────────────────
function getSettings() {
  return {
    bitDur : parseInt($('bitDur').value) / 1000,
    f0     : parseInt($('freq0').value),
    f1     : parseInt($('freq1').value),
    vol    : parseFloat($('vol').value),
  };
}

// ── Status pill ─────────────────────────────────────────
function setStatus(cls, txt) {
  const p = $('statusPill');
  p.className = 'status-pill' + (cls ? ' ' + cls : '');
  $('statusText').textContent = txt;
}

// ── Add message to chat ─────────────────────────────────
function addMsg(text, type) {
  const box = $('messages');
  const d   = document.createElement('div');
  d.className = 'msg ' + type;

  if (type !== 'sys') {
    const lbl = document.createElement('div');
    lbl.className = 'msg-label';
    lbl.textContent = type === 'sent' ? 'TX · you' : 'RX · received';
    d.appendChild(lbl);
  }

  const body = document.createElement('div');
  body.textContent = text;
  d.appendChild(body);

  if (type !== 'sys') {
    const ts = document.createElement('div');
    ts.className = 'msg-ts';
    ts.textContent = new Date().toLocaleTimeString();
    d.appendChild(ts);
  }

  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}

// ── Encode message → bit array ──────────────────────────
// Each char: [11111111] [8 data bits] [00000000]
function encodeMessage(msg) {
  const START = '11111111';
  const STOP  = '00000000';
  return msg.split('').flatMap(ch => {
    const bits = ch.charCodeAt(0).toString(2).padStart(8, '0');
    return [...START, ...bits, ...STOP];
  });
}

// ── Send ────────────────────────────────────────────────
async function sendMessage(msg) {
  if (isSending) return;
  isSending = true;
  $('sendBtn').disabled = true;
  setStatus('active', 'transmitting…');

  const s   = getSettings();
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();

  const bits          = encodeMessage(msg);
  const samplesPerBit = Math.floor(ctx.sampleRate * s.bitDur);
  const totalSamples  = samplesPerBit * bits.length;
  const buf           = ctx.createBuffer(1, totalSamples, ctx.sampleRate);
  const data          = buf.getChannelData(0);

  for (let i = 0; i < bits.length; i++) {
    const f = bits[i] === '0' ? s.f0 : s.f1;
    for (let j = 0; j < samplesPerBit; j++) {
      const t   = (i * samplesPerBit + j) / ctx.sampleRate;
      const env = j < 100
        ? j / 100
        : j > samplesPerBit - 100
          ? (samplesPerBit - j) / 100
          : 1;
      data[i * samplesPerBit + j] = Math.sin(2 * Math.PI * f * t) * env;
    }
  }

  const src = ctx.createBufferSource();
  src.buffer = buf;
  const gain = ctx.createGain();
  gain.gain.value = s.vol;
  src.connect(gain);
  gain.connect(ctx.destination);

  // Progress bar
  const track = $('progressTrack'), fill = $('progressFill');
  track.classList.add('active');
  fill.style.width = '0%';
  const startT   = Date.now();
  const totalMs  = bits.length * s.bitDur * 1000;
  function tickProgress() {
    if (!isSending) return;
    fill.style.width = Math.min(100, (Date.now() - startT) / totalMs * 100).toFixed(1) + '%';
    requestAnimationFrame(tickProgress);
  }
  tickProgress();

  src.start();
  src.onended = () => {
    addMsg(msg, 'sent');
    isSending = false;
    $('sendBtn').disabled = false;
    track.classList.remove('active');
    fill.style.width = '0%';
    setStatus(isListening ? 'active' : '', isListening ? 'listening' : 'idle');
  };
}

// ── Microphone / receive ────────────────────────────────
async function startListening() {
  if (isListening) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation : false,
        noiseSuppression : false,
        autoGainControl  : false,
      }
    });
    const ctx = getCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    const src = ctx.createMediaStreamSource(stream);
    analyser  = ctx.createAnalyser();
    analyser.fftSize               = 4096;
    analyser.smoothingTimeConstant = 0.0;
    src.connect(analyser);

    isListening   = true;
    lastBitTime   = Date.now();
    syncState     = 'idle';
    byteAccum     = [];
    receiveBuffer = [];

    setStatus('active', 'listening');
    $('micBtn').classList.add('on');
    $('micLabel').textContent = 'Mic on';
    addMsg('microphone active — waiting for signal', 'sys');

    schedulePoll();
    drawScope();
  } catch (e) {
    setStatus('error', 'mic denied');
    addMsg('microphone access denied — receive disabled', 'sys');
  }
}

// ── Audio polling ───────────────────────────────────────
function schedulePoll() {
  if (!isListening || !analyser) return;
  setTimeout(() => {
    pollAudio();
    schedulePoll();
  }, Math.floor(getSettings().bitDur * 1000 * 0.4));
}

function pollAudio() {
  if (!isListening || !analyser) return;
  const s       = getSettings();
  const fftBuf  = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(fftBuf);

  const sr      = getCtx().sampleRate;
  const fftSize = analyser.fftSize;

  function peakMag(freq) {
    const center = Math.round(freq * fftSize / sr);
    const W      = 3;
    let   max    = -Infinity;
    for (let i = Math.max(0, center - W); i <= Math.min(fftBuf.length - 1, center + W); i++) {
      if (fftBuf[i] > max) max = fftBuf[i];
    }
    return max;
  }

  const m0  = peakMag(s.f0);
  const m1  = peakMag(s.f1);
  const now = Date.now();

  // Update dB readout
  const peak = Math.max(m0, m1);
  if ($('peakLevel')) $('peakLevel').textContent = peak > -90 ? peak.toFixed(1) + ' dB' : '— dB';

  if (now - lastBitTime >= s.bitDur * 1000 * 0.85) {
    lastBitTime = now;
    const THRESH = -45;
    let bit = null;
    if      (m0 > THRESH && m0 > m1 + 3) bit = '0';
    else if (m1 > THRESH && m1 > m0 + 3) bit = '1';
    if (bit !== null) processBit(bit);
  }
}

// ── FSK decoder (start/stop framing) ───────────────────
function processBit(bit) {
  if (syncState === 'idle') {
    byteAccum.push(bit);
    if (byteAccum.length > 8) byteAccum.shift();
    if (byteAccum.join('') === '11111111') {
      syncState     = 'data';
      receiveBuffer = [];
      byteAccum     = [];
    }
  } else if (syncState === 'data') {
    byteAccum.push(bit);
    if (byteAccum.length === 8) {
      const byte = byteAccum.join('');
      if (byte === '00000000') {
        // stop byte — emit character if we have data bits
        if (receiveBuffer.length > 0) {
          const code = parseInt(receiveBuffer.join(''), 2);
          if (code >= 32 && code <= 126) addMsg(String.fromCharCode(code), 'recv');
        }
        receiveBuffer = [];
        syncState     = 'idle';
      } else {
        receiveBuffer = byteAccum.slice();
      }
      byteAccum = [];
    }
  }
}

// ── Scope (FFT canvas) ──────────────────────────────────
function drawScope() {
  if (!analyser) return;
  const cv  = $('scope');
  if (!cv) return;

  const dpr = window.devicePixelRatio || 1;
  const W   = cv.offsetWidth;
  const H   = cv.offsetHeight;
  cv.width  = W * dpr;
  cv.height = H * dpr;

  const ctx2 = cv.getContext('2d');
  ctx2.scale(dpr, dpr);

  const s      = getSettings();
  const fftBuf = new Float32Array(analyser.frequencyBinCount);
  analyser.getFloatFrequencyData(fftBuf);

  const sr      = getCtx().sampleRate;
  const fftSize = analyser.fftSize;
  const minF    = 16000, maxF = 22500;
  const minB    = Math.floor(minF * fftSize / sr);
  const maxB    = Math.ceil(maxF * fftSize / sr);
  const pts     = maxB - minB;

  ctx2.clearRect(0, 0, W, H);
  ctx2.fillStyle = '#0c0c10';
  ctx2.fillRect(0, 0, W, H);

  // Spectrum line
  ctx2.beginPath();
  for (let i = 0; i < pts; i++) {
    const val = Math.max(-90, Math.min(-10, fftBuf[minB + i]));
    const x   = (i / pts) * W;
    const y   = H - ((val + 90) / 80) * H * 0.88 - 4;
    i === 0 ? ctx2.moveTo(x, y) : ctx2.lineTo(x, y);
  }
  ctx2.strokeStyle = 'rgba(0,200,150,0.75)';
  ctx2.lineWidth   = 1.5;
  ctx2.stroke();

  // Fill under curve
  ctx2.lineTo(W, H); ctx2.lineTo(0, H); ctx2.closePath();
  ctx2.fillStyle = 'rgba(0,200,150,0.07)';
  ctx2.fill();

  // Frequency markers
  function marker(freq, color, label) {
    const b = Math.round(freq * fftSize / sr);
    const x = ((b - minB) / pts) * W;
    ctx2.strokeStyle = color;
    ctx2.lineWidth   = 1;
    ctx2.setLineDash([2, 3]);
    ctx2.beginPath(); ctx2.moveTo(x, 0); ctx2.lineTo(x, H); ctx2.stroke();
    ctx2.setLineDash([]);
    ctx2.fillStyle = color;
    ctx2.font      = '9px Space Mono, monospace';
    ctx2.fillText(label, x + 3, H - 5);
  }
  marker(s.f0, 'rgba(255,77,109,0.65)', 'f0');
  marker(s.f1, 'rgba(0,200,150,0.65)', 'f1');

  scopeFrame = requestAnimationFrame(drawScope);
}

// ── Hero ambient canvas ─────────────────────────────────
function drawHeroCanvas() {
  const cv = $('heroCanvas');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W   = cv.offsetWidth;
  const H   = cv.offsetHeight || 110;
  cv.width  = W * dpr;
  cv.height = H * dpr;
  const c   = cv.getContext('2d');
  c.scale(dpr, dpr);

  let t = 0;
  function frame() {
    c.fillStyle = '#0c0c10';
    c.fillRect(0, 0, W, H);

    // Draw two sine waves representing f0 and f1
    [[18, 'rgba(255,77,109,0.55)', 0], [20, 'rgba(0,200,150,0.55)', 0.8]].forEach(([freq, color, phase]) => {
      c.beginPath();
      for (let x = 0; x < W; x++) {
        const norm = x / W;
        const y    = H / 2 + Math.sin(norm * Math.PI * freq * 0.6 + t + phase) * H * 0.28;
        x === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.strokeStyle = color;
      c.lineWidth   = 1.5;
      c.stroke();
    });

    t += 0.025;
    requestAnimationFrame(frame);
  }
  frame();
}

// ── Slider labels ───────────────────────────────────────
function bindSliders() {
  $('bitDur').addEventListener('input', () => {
    $('bitDurVal').textContent = $('bitDur').value + ' ms';
  });
  $('freq0').addEventListener('input', () => {
    $('freq0Val').textContent = $('freq0').value + ' Hz';
  });
  $('freq1').addEventListener('input', () => {
    $('freq1Val').textContent = $('freq1').value + ' Hz';
  });
  $('vol').addEventListener('input', () => {
    $('volVal').textContent = parseFloat($('vol').value).toFixed(1);
  });
}

// ── Send button / Enter ─────────────────────────────────
$('sendBtn').addEventListener('click', async () => {
  const msg = $('msgInput').value.trim();
  if (!msg) return;
  const ctx = getCtx();
  if (ctx.state === 'suspended') await ctx.resume();
  $('msgInput').value = '';
  sendMessage(msg);
});

$('msgInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') $('sendBtn').click();
});

// ── Mic button ──────────────────────────────────────────
$('micBtn').addEventListener('click', () => {
  if (!micEnabled) {
    micEnabled = true;
    startListening();
  }
});

// ── Nav scroll effect ───────────────────────────────────
window.addEventListener('scroll', () => {
  const nav = document.getElementById('nav');
  if (nav) nav.style.boxShadow = window.scrollY > 10 ? '0 1px 20px rgba(0,0,0,0.08)' : '';
});

// ── Init ────────────────────────────────────────────────
bindSliders();
drawHeroCanvas();

// Auto-prompt mic on first composer focus (UX nudge)
$('msgInput').addEventListener('focus', () => {
  if (!micEnabled) {
    micEnabled = true;
    startListening();
  }
}, { once: true });
