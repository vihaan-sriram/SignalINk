const ctx = new (window.AudioContext || window.webkitAudioContext)();
const sampleRate = ctx.sampleRate;
const frequency0 = 18000; // Hz for bit '0'
const frequency1 = 20000; // Hz for bit '1'
const bitDuration = 0.1; // seconds per bit
let isListening = false;

const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const receivedMessages = document.getElementById('receivedMessages');

async function requestMicAccess() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        return stream;
    } catch (err) {
        receivedMessages.innerHTML += 'Microphone access denied.<br>';
        console.error('Mic access error:', err);
        return null;
    }
}

function sendMessage(message) {
    // Convert message to binary
    const binary = Array.from(message)
        .map(char => char.charCodeAt(0).toString(2).padStart(8, '0'))
        .join('');

    // Generate chirps
    const samplesPerBit = Math.floor(sampleRate * bitDuration);
    const buffer = ctx.createBuffer(1, samplesPerBit * binary.length, sampleRate);
    const data = buffer.getChannelData(0);

    for (let i = 0; i < binary.length; i++) {
        const frequency = binary[i] === '0' ? frequency0 : frequency1;
        for (let j = 0; j < samplesPerBit; j++) {
            const t = (i * samplesPerBit + j) / sampleRate;
            data[i * samplesPerBit + j] = Math.sin(2 * Math.PI * frequency * t);
        }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start();
    source.onended = () => {
        receivedMessages.innerHTML += `Sent: ${message}<br>`;
    };
}

async function startListening() {
    if (isListening) return;
    const stream = await requestMicAccess();
    if (!stream) return;

    isListening = true;
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Float32Array(bufferLength);
    const bits = [];
    let lastBitTime = 0;

    function processAudio() {
        if (!isListening) return;
        analyser.getFloatFrequencyData(dataArray);

        // Detect frequency (simplified, using FFT)
        const bin0 = Math.floor(frequency0 * analyser.fftSize / sampleRate);
        const bin1 = Math.floor(frequency1 * analyser.fftSize / sampleRate);
        const magnitude0 = dataArray[bin0];
        const magnitude1 = dataArray[bin1];

        const currentTime = Date.now();
        if (currentTime - lastBitTime >= bitDuration * 1000) {
            if (magnitude0 > -50 && magnitude0 > magnitude1) {
                bits.push('0');
            } else if (magnitude1 > -50 && magnitude1 > magnitude0) {
                bits.push('1');
            }

            // Decode every 8 bits
            if (bits.length >= 8) {
                const byteString = bits.slice(-8).join('');
                const charCode = parseInt(byteString, 2);
                if (charCode >= 32 && charCode <= 126) { // Printable ASCII
                    receivedMessages.innerHTML += `Received: ${String.fromCharCode(charCode)}<br>`;
                }
                bits.length = 0; // Reset for next character
            }
            lastBitTime = currentTime;
        }

        requestAnimationFrame(processAudio);
    }

    processAudio();
}

sendButton.addEventListener('click', () => {
    const message = messageInput.value.trim();
    if (message) {
        sendMessage(message);
        messageInput.value = '';
    }
});

// Start listening on page load
startListening();