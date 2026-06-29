const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SAMPLE_RATE = 44100;
const OUTPUT_DIR = path.join(__dirname, '..', 'assets', 'sounds');
const MAX_16_BIT = 32767;

function clamp(value, min = -1, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function triangleWave(phase) {
  return (2 / Math.PI) * Math.asin(Math.sin(phase));
}

function envelope(index, totalSamples, attackMs, decayMs) {
  const attackSamples = Math.max(1, Math.round((attackMs / 1000) * SAMPLE_RATE));
  const decaySamples = Math.max(1, Math.round((decayMs / 1000) * SAMPLE_RATE));
  const attack = Math.min(1, index / attackSamples);
  const decay = Math.min(1, (totalSamples - index - 1) / decaySamples);

  return Math.max(0, Math.min(attack, decay));
}

function writeWav(filename, samples) {
  const dataSize = samples.length * 2;
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

  samples.forEach((sample, index) => {
    buffer.writeInt16LE(Math.round(clamp(sample) * MAX_16_BIT), 44 + index * 2);
  });

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUTPUT_DIR, filename), buffer);
}

function findChunk(buffer, id) {
  let offset = 12;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);

    if (chunkId === id) {
      return { offset: offset + 8, size };
    }

    offset += 8 + size + (size % 2);
  }

  return null;
}

function readWavSamples(filePath) {
  const buffer = fs.readFileSync(filePath);
  const fmt = findChunk(buffer, 'fmt ');
  const data = findChunk(buffer, 'data');

  if (!fmt || !data) {
    throw new Error(`Invalid WAV file: ${filePath}`);
  }

  const audioFormat = buffer.readUInt16LE(fmt.offset);
  const channelCount = buffer.readUInt16LE(fmt.offset + 2);
  const sampleRate = buffer.readUInt32LE(fmt.offset + 4);
  const bitsPerSample = buffer.readUInt16LE(fmt.offset + 14);

  if (audioFormat !== 1 || bitsPerSample !== 16) {
    throw new Error(`Expected PCM 16-bit WAV: ${filePath}`);
  }

  const frameCount = data.size / (2 * channelCount);
  const samples = new Array(frameCount);

  for (let frame = 0; frame < frameCount; frame += 1) {
    let sum = 0;

    for (let channel = 0; channel < channelCount; channel += 1) {
      const sampleOffset = data.offset + (frame * channelCount + channel) * 2;
      sum += buffer.readInt16LE(sampleOffset) / MAX_16_BIT;
    }

    samples[frame] = sum / channelCount;
  }

  return { sampleRate, samples };
}

function trimSilence(samples, threshold = 0.012, paddingMs = 40) {
  const padding = Math.round((paddingMs / 1000) * SAMPLE_RATE);
  let start = 0;
  let end = samples.length - 1;

  while (start < samples.length && Math.abs(samples[start]) < threshold) {
    start += 1;
  }

  while (end > start && Math.abs(samples[end]) < threshold) {
    end -= 1;
  }

  return samples.slice(Math.max(0, start - padding), Math.min(samples.length, end + padding));
}

function onePoleLowPass(samples, cutoffHz) {
  const alpha = (2 * Math.PI * cutoffHz) / (2 * Math.PI * cutoffHz + SAMPLE_RATE);
  let previous = 0;

  return samples.map((sample) => {
    previous += alpha * (sample - previous);
    return previous;
  });
}

function onePoleHighPass(samples, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / SAMPLE_RATE;
  const alpha = rc / (rc + dt);
  let previousInput = 0;
  let previousOutput = 0;

  return samples.map((sample) => {
    const output = alpha * (previousOutput + sample - previousInput);
    previousInput = sample;
    previousOutput = output;
    return output;
  });
}

function normalize(samples, peak = 0.78) {
  const max = samples.reduce((largest, sample) => Math.max(largest, Math.abs(sample)), 0);

  if (max === 0) {
    return samples;
  }

  const scale = peak / max;
  return samples.map((sample) => clamp(sample * scale));
}

function resampleLinear(samples, factor) {
  const outputLength = Math.max(1, Math.round(samples.length * factor));
  const output = new Array(outputLength);

  for (let index = 0; index < outputLength; index += 1) {
    const sourceIndex = index / factor;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(samples.length - 1, lower + 1);
    const ratio = sourceIndex - lower;
    const lowerSample = samples[Math.min(samples.length - 1, lower)] ?? 0;
    const upperSample = samples[upper] ?? lowerSample;

    output[index] = lowerSample * (1 - ratio) + upperSample * ratio;
  }

  return output;
}

function processedMarksCueSamples(sourcePath) {
  const { sampleRate, samples } = readWavSamples(sourcePath);

  if (sampleRate !== SAMPLE_RATE) {
    throw new Error(`Expected ${SAMPLE_RATE} Hz WAV from speech engine, got ${sampleRate}`);
  }

  const trimmed = trimSilence(samples, 0.01, 28);
  const lowered = resampleLinear(trimmed, 1.12);
  const bandPassed = onePoleLowPass(onePoleHighPass(lowered, 120), 2900);

  const processedVoice = bandPassed.map((sample, index) => {
    const t = index / SAMPLE_RATE;
    const modulation = 0.92 + 0.08 * Math.sin(2 * Math.PI * 18 * t);
    const compressed = Math.tanh(sample * modulation * 1.65) / Math.tanh(1.65);

    return Math.round(compressed * 512) / 512;
  });

  return normalize(processedVoice, 0.8);
}

function singleTone({
  filename,
  frequency,
  durationMs,
  gain,
  attackMs,
  decayMs,
  waveform = 'sine',
}) {
  const totalSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Array(totalSamples);

  for (let i = 0; i < totalSamples; i += 1) {
    const phase = 2 * Math.PI * frequency * (i / SAMPLE_RATE);
    const raw = waveform === 'triangle' ? triangleWave(phase) : Math.sin(phase);
    samples[i] = raw * gain * envelope(i, totalSamples, attackMs, decayMs);
  }

  writeWav(filename, samples);
}

function completeTone() {
  const first = toneSamples({ frequency: 800, durationMs: 120, gain: 0.9, attackMs: 4, decayMs: 35 });
  const silence = new Array(Math.round(0.09 * SAMPLE_RATE)).fill(0);
  const second = toneSamples({
    frequency: 1200,
    durationMs: 160,
    gain: 0.95,
    attackMs: 4,
    decayMs: 45,
  });

  writeWav('complete_beep.wav', [...first, ...silence, ...second]);
}

function toneSamples({ frequency, durationMs, gain, attackMs, decayMs }) {
  const totalSamples = Math.round((durationMs / 1000) * SAMPLE_RATE);
  const samples = new Array(totalSamples);

  for (let i = 0; i < totalSamples; i += 1) {
    const phase = 2 * Math.PI * frequency * (i / SAMPLE_RATE);
    samples[i] = Math.sin(phase) * gain * envelope(i, totalSamples, attackMs, decayMs);
  }

  return samples;
}

function powerShellString(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function spokenTakeYourMarksCue() {
  const filename = 'take_your_marks_cue.wav';
  const outputPath = path.join(OUTPUT_DIR, filename);
  const rawPath = path.join(OUTPUT_DIR, 'take_your_marks_raw.wav');

  if (process.platform !== 'win32') {
    if (fs.existsSync(outputPath)) {
      console.log(`Keeping existing ${filename}; spoken cue generation requires Windows.`);
      return;
    }

    throw new Error('Generating take_your_marks_cue.wav requires Windows System.Speech.');
  }

  const script = `
Add-Type -AssemblyName System.Speech
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(44100, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo }
$voice = $voices | Where-Object { $_.Gender -eq 'Male' -and $_.Age -eq 'Senior' } | Select-Object -First 1
if ($null -eq $voice) { $voice = $voices | Where-Object { $_.Gender -eq 'Male' } | Select-Object -First 1 }
if ($null -ne $voice) { $synth.SelectVoice($voice.Name) }
$synth.Rate = -3
$synth.Volume = 100
$synth.SetOutputToWaveFile(${powerShellString(rawPath)}, $format)
$synth.Speak('Take your marks')
$synth.Dispose()
`;

  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { stdio: 'inherit' }
  );

  writeWav(filename, processedMarksCueSamples(rawPath));
  fs.rmSync(rawPath, { force: true });
}

function preserveManualAsset(filename, generateFallback) {
  const filePath = path.join(OUTPUT_DIR, filename);

  if (fs.existsSync(filePath)) {
    console.log(`Keeping existing ${filename}`);
    return;
  }

  generateFallback();
}

preserveManualAsset('start_beep.wav', () => {
  singleTone({
    filename: 'start_beep.wav',
    frequency: 1800,
    durationMs: 410,
    gain: 0.72,
    attackMs: 4,
    decayMs: 55,
    waveform: 'sine',
  });
});

singleTone({
  filename: 'countdown_beep.wav',
  frequency: 1100,
  durationMs: 100,
  gain: 0.9,
  attackMs: 4,
  decayMs: 30,
  waveform: 'sine',
});

singleTone({
  filename: 'reminder_beep.wav',
  frequency: 1550,
  durationMs: 240,
  gain: 1,
  attackMs: 4,
  decayMs: 45,
  waveform: 'sine',
});

completeTone();
preserveManualAsset('take_your_marks_cue.wav', spokenTakeYourMarksCue);

console.log(`Generated cue WAV files in ${OUTPUT_DIR}`);
