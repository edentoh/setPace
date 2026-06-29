const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 44100;
const DURATION_MS = 160;
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'sounds');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'silence_warmup.wav');

const sampleCount = Math.round((DURATION_MS / 1000) * SAMPLE_RATE);
const dataSize = sampleCount * 2;
const buffer = Buffer.alloc(44 + dataSize);

buffer.write('RIFF', 0);
buffer.writeUInt32LE(36 + dataSize, 4);
buffer.write('WAVE', 8);
buffer.write('fmt ', 12);
buffer.writeUInt32LE(16, 16);
buffer.writeUInt16LE(1, 20);
buffer.writeUInt16LE(1, 22);
buffer.writeUInt32LE(SAMPLE_RATE, 24);
buffer.writeUInt32LE(SAMPLE_RATE * 2, 28);
buffer.writeUInt16LE(2, 32);
buffer.writeUInt16LE(16, 34);
buffer.write('data', 36);
buffer.writeUInt32LE(dataSize, 40);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
fs.writeFileSync(OUTPUT_FILE, buffer);
console.log(`Generated ${OUTPUT_FILE}`);
