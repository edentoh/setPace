import { Asset } from 'expo-asset';
import { createAudioPlayer, preload, setAudioModeAsync } from 'expo-audio';

type CueKind = 'start' | 'countdown' | 'mark' | 'complete' | 'warmup';
type CuePlayer = ReturnType<typeof createAudioPlayer>;
type CueSource = Parameters<typeof createAudioPlayer>[0];

type CuePlayers = Record<CueKind, CuePlayer>;
type CueSources = Record<CueKind, CueSource>;

type CueMeta = {
  cueKey?: string;
  repIndex?: number;
  runSequence?: number;
};

type AudioState = {
  audioReady: boolean;
  preloadComplete: boolean;
  warmupComplete: boolean;
  playersCreated: boolean;
  preparing: boolean;
  lastError: string | null;
};

const START_SOUND = require('@/assets/sounds/start_beep.wav');
const COUNTDOWN_SOUND = require('@/assets/sounds/countdown_beep.wav');
const MARK_SOUND = require('@/assets/sounds/take_your_marks_cue.wav');
const COMPLETE_SOUND = require('@/assets/sounds/complete_beep.wav');
const WARMUP_SOUND = require('@/assets/sounds/silence_warmup.wav');

const PLAYER_OPTIONS = {
  keepAudioSessionActive: true,
  preferredForwardBufferDuration: 1,
  updateInterval: 1000,
};
const WARMUP_PLAY_MS = 180;
const START_MUTED_WARMUP_MS = 180;
const ACTUAL_PLAYER_PRIME_MS = 120;
const ACTUAL_PLAYER_PRIME_VOLUME = 0.001;

let players: CuePlayers | null = null;
let cueSources: CueSources | null = null;
let preloadPromise: Promise<void> | null = null;
let warmupPromise: Promise<void> | null = null;
let startPrimePromise: Promise<void> | null = null;
let startPrimeRunSequence: number | undefined;
let startPlayerGeneration = 0;
let activeRunSequence: number | null = null;
let audioState: AudioState = {
  audioReady: false,
  preloadComplete: false,
  warmupComplete: false,
  playersCreated: false,
  preparing: false,
  lastError: null,
};

function isDevelopment() {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function serializeError(error: unknown) {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: String(error) };
}

function playerState(player: CuePlayer | null | undefined) {
  if (!player) {
    return null;
  }

  try {
    const status = player.currentStatus;

    return {
      id: player.id,
      currentTime: player.currentTime,
      duration: player.duration,
      isBuffering: player.isBuffering,
      isLoaded: player.isLoaded,
      muted: player.muted,
      paused: player.paused,
      playing: player.playing,
      volume: player.volume,
      status: status
        ? {
            didJustFinish: status.didJustFinish,
            error: status.error,
            isBuffering: status.isBuffering,
            isLoaded: status.isLoaded,
            playbackState: status.playbackState,
            playing: status.playing,
            timeControlStatus: status.timeControlStatus,
          }
        : null,
    };
  } catch (error) {
    return { error: serializeError(error) };
  }
}

function setAudioState(nextState: Partial<AudioState>) {
  audioState = { ...audioState, ...nextState };
}

function isCueMetaCurrent(meta: CueMeta = {}) {
  return (
    meta.runSequence === undefined ||
    activeRunSequence === null ||
    meta.runSequence === activeRunSequence
  );
}

function logSkippedStaleCue(event: string, meta: CueMeta = {}) {
  cueAudioLog(event, {
    ...meta,
    activeRunSequence,
  });
}

export function getCueAudioState() {
  return { ...audioState };
}

export function isCueAudioReady() {
  return audioState.audioReady && audioState.warmupComplete;
}

export function setCueAudioRunSequence(runSequence: number | null) {
  activeRunSequence = runSequence;
  cueAudioLog('audio run sequence changed', { activeRunSequence });
}

export function cueAudioLog(event: string, details: Record<string, unknown> = {}) {
  if (!isDevelopment()) {
    return;
  }

  console.log('[SetPace audio]', {
    at: Date.now(),
    event,
    audioReady: audioState.audioReady,
    preloadComplete: audioState.preloadComplete,
    warmupComplete: audioState.warmupComplete,
    ...details,
  });
}

function cueAudioWarn(event: string, error: unknown, details: Record<string, unknown> = {}) {
  setAudioState({ lastError: serializeError(error).message });

  if (!isDevelopment()) {
    return;
  }

  console.warn('[SetPace audio]', {
    at: Date.now(),
    event,
    audioReady: audioState.audioReady,
    preloadComplete: audioState.preloadComplete,
    warmupComplete: audioState.warmupComplete,
    error: serializeError(error),
    ...details,
  });
}

async function configureAudioSession() {
  await setAudioModeAsync({
    allowsRecording: false,
    interruptionMode: 'mixWithOthers',
    playsInSilentMode: true,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
  });
}

function createCuePlayers() {
  if (players !== null) {
    return players;
  }

  const sources = getCueSources();
  players = {
    complete: createAudioPlayer(sources.complete, PLAYER_OPTIONS),
    countdown: createAudioPlayer(sources.countdown, PLAYER_OPTIONS),
    mark: createAudioPlayer(sources.mark, PLAYER_OPTIONS),
    start: createAudioPlayer(sources.start, PLAYER_OPTIONS),
    warmup: createAudioPlayer(sources.warmup, PLAYER_OPTIONS),
  };
  startPlayerGeneration += 1;
  setAudioState({ playersCreated: true });
  cueAudioLog('start player created', {
    generation: startPlayerGeneration,
    startPlayer: playerState(players.start),
  });

  return players;
}

function getPlayers() {
  return players ?? createCuePlayers();
}

function getCueSources() {
  return (
    cueSources ?? {
      complete: COMPLETE_SOUND,
      countdown: COUNTDOWN_SOUND,
      mark: MARK_SOUND,
      start: START_SOUND,
      warmup: WARMUP_SOUND,
    }
  );
}

function allPlayersLoaded(cuePlayers: CuePlayers) {
  return Object.values(cuePlayers).every((player) => player.isLoaded);
}

async function waitForPlayersLoaded(cuePlayers: CuePlayers, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const erroredPlayer = Object.entries(cuePlayers).find(
      ([, player]) => player.currentStatus.error !== null
    );

    if (erroredPlayer) {
      throw new Error(
        `${erroredPlayer[0]} player failed to load: ${erroredPlayer[1].currentStatus.error}`
      );
    }

    if (allPlayersLoaded(cuePlayers)) {
      return true;
    }

    await wait(40);
  }

  cueAudioLog('audio player load status timed out; continuing with warmup', {
    completePlayer: playerState(cuePlayers.complete),
    countdownPlayer: playerState(cuePlayers.countdown),
    markPlayer: playerState(cuePlayers.mark),
    startPlayer: playerState(cuePlayers.start),
    warmupPlayer: playerState(cuePlayers.warmup),
  });
  return false;
}

function recreateCuePlayer(kind: CueKind, reason: string) {
  const cuePlayers = getPlayers();
  const currentPlayer = cuePlayers[kind];

  try {
    currentPlayer.remove();
  } catch (error) {
    cueAudioWarn(`${kind} player remove failed`, error, {
      generation: startPlayerGeneration,
      reason,
    });
  }

  cuePlayers[kind] = createAudioPlayer(getCueSources()[kind], PLAYER_OPTIONS);
  if (kind === 'start') {
    startPlayerGeneration += 1;
  }

  cueAudioLog(`${kind} player created`, {
    generation: startPlayerGeneration,
    reason,
    player: playerState(cuePlayers[kind]),
  });
}

function recreateStartPlayer(reason: string) {
  recreateCuePlayer('start', reason);
}

export function recreateCuePlayersForRun(reason: string) {
  if (players === null) {
    return;
  }

  recreateCuePlayer('start', reason);
  recreateCuePlayer('countdown', reason);
  recreateCuePlayer('mark', reason);
  recreateCuePlayer('complete', reason);
}

async function warmupDisposableCuePlayer(kind: Exclude<CueKind, 'warmup'>, reason: string) {
  const player = createAudioPlayer(getCueSources()[kind], PLAYER_OPTIONS);

  cueAudioLog(`disposable ${kind} warmup player created`, {
    reason,
    player: playerState(player),
  });

  try {
    await warmupPlayer(player, kind, 0, START_MUTED_WARMUP_MS);
  } finally {
    try {
      player.remove();
    } catch (error) {
      cueAudioWarn(`disposable ${kind} warmup player remove failed`, error, {
        reason,
        player: playerState(player),
      });
    }
  }
}

async function warmupDisposableStartPlayer(reason: string) {
  await warmupDisposableCuePlayer('start', reason);
}

async function primeActualCuePlayer(
  kind: Exclude<CueKind, 'warmup'>,
  reason: string,
  meta: CueMeta = {}
) {
  if (!isCueMetaCurrent(meta)) {
    logSkippedStaleCue(`${kind} actual player prime skipped for stale run`, meta);
    return;
  }

  const player = getPlayers()[kind];
  const originalVolume = player.volume;
  const originalMuted = player.muted;

  try {
    player.muted = false;
    player.volume = ACTUAL_PLAYER_PRIME_VOLUME;
    await resetPlayer(player);

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue(`${kind} actual player prime stopped before play`, meta);
      return;
    }

    player.play();
    cueAudioLog(`${kind} actual player prime started`, {
      ...meta,
      reason,
      player: playerState(player),
    });
    await wait(ACTUAL_PLAYER_PRIME_MS);

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue(`${kind} actual player prime stopped before reset`, meta);
      return;
    }

    player.pause();
    await resetPlayer(player);
    cueAudioLog(`${kind} actual player prime finished`, {
      ...meta,
      reason,
      player: playerState(player),
    });
  } finally {
    player.muted = false;
    player.volume = Math.max(originalVolume, 1);
    if (originalMuted) {
      cueAudioLog(`${kind} actual player prime cleared muted state`, { reason });
    }
  }
}

async function resolveBundledSound(source: number) {
  const asset = Asset.fromModule(source);
  await asset.downloadAsync();
  return {
    uri: asset.localUri ?? asset.uri,
  };
}

async function resolveCueSources() {
  if (cueSources !== null) {
    return cueSources;
  }

  const [complete, countdown, mark, start, warmup] = await Promise.all([
    resolveBundledSound(COMPLETE_SOUND),
    resolveBundledSound(COUNTDOWN_SOUND),
    resolveBundledSound(MARK_SOUND),
    resolveBundledSound(START_SOUND),
    resolveBundledSound(WARMUP_SOUND),
  ]);

  cueSources = {
    complete,
    countdown,
    mark,
    start,
    warmup,
  };

  cueAudioLog('audio assets resolved', {
    complete,
    countdown,
    mark,
    start,
    warmup,
  });

  return cueSources;
}

async function preloadAsset(source: CueSource) {
  await preload(source as Parameters<typeof preload>[0], { preferredForwardBufferDuration: 1 });
}

export async function preloadCues() {
  if (preloadPromise !== null) {
    return preloadPromise;
  }

  preloadPromise = (async () => {
    cueAudioLog('audio preload started');
    setAudioState({
      audioReady: false,
      lastError: null,
      preparing: true,
      warmupComplete: false,
    });

    await configureAudioSession();
    const sources = await resolveCueSources();
    await Promise.all([
      preloadAsset(sources.start),
      preloadAsset(sources.countdown),
      preloadAsset(sources.mark),
      preloadAsset(sources.complete),
      preloadAsset(sources.warmup),
    ]);

    const cuePlayers = createCuePlayers();
    const allLoaded = await waitForPlayersLoaded(cuePlayers);
    setAudioState({ preloadComplete: true });
    cueAudioLog('audio preload finished', {
      allLoaded,
      completePlayer: playerState(cuePlayers.complete),
      countdownPlayer: playerState(cuePlayers.countdown),
      markPlayer: playerState(cuePlayers.mark),
      startPlayer: playerState(cuePlayers.start),
      warmupPlayer: playerState(cuePlayers.warmup),
    });
  })();

  try {
    await preloadPromise;
  } catch (error) {
    setAudioState({
      audioReady: false,
      lastError: serializeError(error).message,
      preloadComplete: false,
      warmupComplete: false,
    });
    cueAudioWarn('audio preload failed', error);
    throw error;
  } finally {
    preloadPromise = null;
  }
}

async function resetPlayer(player: CuePlayer) {
  try {
    if (player.playing || player.currentTime > 0) {
      player.pause();
    }
  } catch (error) {
    cueAudioWarn('cue player pause before reset failed', error, {
      player: playerState(player),
    });
  }

  try {
    await player.seekTo(0);
  } catch (error) {
    cueAudioWarn('cue player seek before reset failed', error, {
      player: playerState(player),
    });
  }
}

async function warmupPlayer(player: CuePlayer, kind: CueKind, volume: number, durationMs: number) {
  const originalVolume = player.volume;
  const originalMuted = player.muted;

  try {
    player.muted = volume <= 0;
    player.volume = volume;
    await resetPlayer(player);
    player.play();
    cueAudioLog(`${kind} warmup play started`, { player: playerState(player) });
    await wait(durationMs);

    try {
      player.pause();
    } catch (error) {
      cueAudioWarn(`${kind} warmup pause failed`, error, { player: playerState(player) });
    }

    await resetPlayer(player);
    cueAudioLog(`${kind} warmup completed`, { player: playerState(player) });
  } finally {
    player.muted = originalMuted;
    player.volume = originalVolume;
  }
}

export async function warmupCues() {
  if (audioState.warmupComplete && audioState.audioReady) {
    return;
  }

  if (warmupPromise !== null) {
    return warmupPromise;
  }

  warmupPromise = (async () => {
    setAudioState({
      audioReady: false,
      lastError: null,
      preparing: true,
      warmupComplete: false,
    });

    await preloadCues();
    await configureAudioSession();

    const cuePlayers = getPlayers();

    cueAudioLog('audio warmup started', {
      startPlayer: playerState(cuePlayers.start),
      warmupPlayer: playerState(cuePlayers.warmup),
    });

    await warmupPlayer(cuePlayers.warmup, 'warmup', 1, WARMUP_PLAY_MS).catch((error) => {
      cueAudioWarn('silent audio warmup failed; continuing', error, {
        warmupPlayer: playerState(cuePlayers.warmup),
      });
    });
    await warmupDisposableStartPlayer('startup').catch((error) => {
      cueAudioWarn('disposable start audio warmup failed; continuing', error, {
        generation: startPlayerGeneration,
        startPlayer: playerState(getPlayers().start),
      });
    });
    recreateStartPlayer('after-disposable-start-warmup');
    await primeActualCuePlayer('start', 'startup').catch((error) => {
      cueAudioWarn('start actual player prime failed; continuing', error, {
        startPlayer: playerState(getPlayers().start),
      });
    });
    await warmupDisposableCuePlayer('countdown', 'startup').catch((error) => {
      cueAudioWarn('disposable countdown audio warmup failed; continuing', error, {
        countdownPlayer: playerState(getPlayers().countdown),
      });
    });
    recreateCuePlayer('countdown', 'after-disposable-countdown-warmup');
    await primeActualCuePlayer('countdown', 'startup').catch((error) => {
      cueAudioWarn('countdown actual player prime failed; continuing', error, {
        countdownPlayer: playerState(getPlayers().countdown),
      });
    });

    setAudioState({
      audioReady: true,
      lastError: null,
      preparing: false,
      warmupComplete: true,
    });
    cueAudioLog('audio warmup finished', {
      startPlayer: playerState(cuePlayers.start),
      warmupPlayer: playerState(cuePlayers.warmup),
    });
  })();

  try {
    await warmupPromise;
  } catch (error) {
    setAudioState({
      audioReady: false,
      lastError: serializeError(error).message,
      preparing: false,
      warmupComplete: false,
    });
    cueAudioWarn('audio warmup failed', error);
    throw error;
  } finally {
    warmupPromise = null;
  }
}

export async function ensureAudioReady() {
  if (isCueAudioReady()) {
    return;
  }

  await warmupCues();
}

export async function primeStartCueAfterInteraction(meta: CueMeta = {}) {
  if (startPrimePromise !== null) {
    await startPrimePromise.catch(() => undefined);

    if (startPrimeRunSequence === meta.runSequence) {
      return;
    }
  }

  startPrimeRunSequence = meta.runSequence;
  startPrimePromise = (async () => {
    await preloadCues();

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue('cue interaction prime skipped for stale run', meta);
      return;
    }

    cueAudioLog('start cue interaction prime started', {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(players?.start),
    });

    await configureAudioSession();

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue('cue interaction prime stopped after audio session for stale run', meta);
      return;
    }

    await warmupDisposableStartPlayer('user-interaction');

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue('cue interaction prime stopped before start recreate for stale run', meta);
      return;
    }

    recreateStartPlayer('after-user-interaction-prime');
    await primeActualCuePlayer('start', 'user-interaction', meta).catch((error) => {
      cueAudioWarn('start actual player interaction prime failed; continuing', error, {
        ...meta,
        startPlayer: playerState(getPlayers().start),
      });
    });

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue('cue interaction prime stopped before countdown warmup for stale run', meta);
      return;
    }

    await warmupDisposableCuePlayer('countdown', 'user-interaction');

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue('cue interaction prime stopped before countdown recreate for stale run', meta);
      return;
    }

    recreateCuePlayer('countdown', 'after-user-interaction-prime');
    await primeActualCuePlayer('countdown', 'user-interaction', meta).catch((error) => {
      cueAudioWarn('countdown actual player interaction prime failed; continuing', error, {
        ...meta,
        countdownPlayer: playerState(getPlayers().countdown),
      });
    });

    cueAudioLog('start cue interaction prime finished', {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(getPlayers().start),
      countdownPlayer: playerState(getPlayers().countdown),
    });
  })();

  try {
    await startPrimePromise;
  } catch (error) {
    cueAudioWarn('start cue interaction prime failed', error, {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(getPlayers().start),
    });
    throw error;
  } finally {
    startPrimePromise = null;
    startPrimeRunSequence = undefined;
  }
}

export function invalidateCueAudio(reason: string) {
  setAudioState({
    audioReady: false,
    preparing: false,
    warmupComplete: false,
  });
  cueAudioLog('audio invalidated', { reason });
}

async function playCuePlayer(kind: Exclude<CueKind, 'warmup'>, meta: CueMeta = {}) {
  const player = getPlayers()[kind];

  if (!isCueMetaCurrent(meta)) {
    logSkippedStaleCue(`${kind} cue skipped before request for stale run`, meta);
    return false;
  }

  cueAudioLog(`${kind} cue requested`, {
    ...meta,
    player: playerState(player),
  });

  try {
    if (!isCueAudioReady()) {
      void ensureAudioReady().catch((error) => {
        cueAudioWarn(`${kind} cue background audio prepare failed`, error, {
          ...meta,
          player: playerState(player),
        });
      });
    }

    await resetPlayer(player);

    if (!isCueMetaCurrent(meta)) {
      logSkippedStaleCue(`${kind} cue skipped after reset for stale run`, meta);
      return false;
    }

    player.muted = false;
    player.volume = 1;
    player.play();
    cueAudioLog(`${kind} cue play started`, {
      ...meta,
      player: playerState(player),
    });
    return true;
  } catch (error) {
    cueAudioWarn(`${kind} cue play failed`, error, {
      ...meta,
      player: playerState(player),
    });
    throw error;
  }
}

async function playStartCueOnce(meta: CueMeta) {
  if (!isCueMetaCurrent(meta)) {
    logSkippedStaleCue('start cue skipped before play for stale run', meta);
    return false;
  }

  const cuePlayers = getPlayers();
  const startPlayer = cuePlayers.start;
  const status = startPlayer.currentStatus;

  if (status.error !== null) {
    cueAudioLog('start player invalid before play', {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(startPlayer),
    });
    recreateStartPlayer('invalid-before-play');
    await wait(40);
  } else if (!startPlayer.isLoaded) {
    cueAudioLog('start player not reported loaded before play; trying playback', {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(startPlayer),
    });
  }

  const player = getPlayers().start;

  await resetPlayer(player);

  if (!isCueMetaCurrent(meta)) {
    logSkippedStaleCue('start cue skipped after reset for stale run', meta);
    return false;
  }

  player.muted = false;
  player.volume = 1;
  player.play();
  cueAudioLog('start cue play started', {
    ...meta,
    generation: startPlayerGeneration,
    startPlayer: playerState(player),
  });

  const durationMs = Math.max(80, Math.min(1200, Math.round((player.duration || 0.45) * 1000)));
  void wait(durationMs + 50).then(() => {
    cueAudioLog('start cue play completed', {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(player),
    });
  });

  return true;
}

export async function playStartCue(meta: CueMeta = {}) {
  cueAudioLog('start cue requested', {
    ...meta,
    generation: startPlayerGeneration,
    startPlayer: playerState(getPlayers().start),
  });

  try {
    if (!isCueAudioReady()) {
      void ensureAudioReady().catch((error) => {
        cueAudioWarn('start cue background audio prepare failed', error, {
          ...meta,
          generation: startPlayerGeneration,
          startPlayer: playerState(getPlayers().start),
        });
      });
    }

    return await playStartCueOnce(meta);
  } catch (firstError) {
    cueAudioWarn('start cue play failed', firstError, {
      ...meta,
      generation: startPlayerGeneration,
      startPlayer: playerState(getPlayers().start),
    });

    recreateStartPlayer('start-cue-retry');

    try {
      await wait(40);
      try {
        await warmupDisposableStartPlayer('start-cue-retry');
        recreateStartPlayer('after-start-cue-retry-warmup');
      } catch (warmupError) {
        cueAudioWarn('start cue retry warmup failed; trying playback', warmupError, {
          ...meta,
          generation: startPlayerGeneration,
          startPlayer: playerState(getPlayers().start),
        });
      }
      return await playStartCueOnce(meta);
    } catch (retryError) {
      cueAudioWarn('start cue retry failed', retryError, {
        ...meta,
        generation: startPlayerGeneration,
        startPlayer: playerState(getPlayers().start),
      });
      throw retryError;
    }
  }
}

export async function playCountdownCue(meta: CueMeta = {}) {
  return playCuePlayer('countdown', meta);
}

export async function playMarkCue(meta: CueMeta = {}) {
  return playCuePlayer('mark', meta);
}

export async function playCompleteCue(meta: CueMeta = {}) {
  return playCuePlayer('complete', meta);
}

export function stopAllCues() {
  if (players === null) {
    return;
  }

  Object.entries(players).forEach(([kind, player]) => {
    try {
      player.muted = false;
      player.volume = 1;
      player.pause();
      void player.seekTo(0).catch((error) => {
        cueAudioWarn(`${kind} cue reset failed`, error, { player: playerState(player) });
      });
    } catch (error) {
      cueAudioWarn(`${kind} cue stop failed`, error, { player: playerState(player) });
    }
  });
}
