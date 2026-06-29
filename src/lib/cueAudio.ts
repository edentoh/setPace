import { Asset } from 'expo-asset';
import { createAudioPlayer, preload, setAudioModeAsync } from 'expo-audio';

type CueKind = 'start' | 'countdown' | 'mark' | 'reminder' | 'complete';
type PlayableCueKind = CueKind;
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
  playersCreated: boolean;
  preparing: boolean;
  lastError: string | null;
};

const START_SOUND = require('@/assets/sounds/start_beep.wav');
const COUNTDOWN_SOUND = require('@/assets/sounds/countdown_beep.wav');
const MARK_SOUND = require('@/assets/sounds/take_your_marks_cue.wav');
const REMINDER_SOUND = require('@/assets/sounds/reminder_beep.wav');
const COMPLETE_SOUND = require('@/assets/sounds/complete_beep.wav');

const PLAYER_OPTIONS = {
  keepAudioSessionActive: true,
  preferredForwardBufferDuration: 1,
  updateInterval: 1000,
};
const PLAYER_LOAD_TIMEOUT_MS = 1200;
const PREPARE_TIMEOUT_MS = 3500;
const REMINDER_VOLUME = 1;

let players: CuePlayers | null = null;
let cueSources: CueSources | null = null;
let preloadPromise: Promise<void> | null = null;
let preparePromise: Promise<boolean> | null = null;
let activeRunSequence: number | null = null;
let audioState: AudioState = {
  audioReady: false,
  lastError: null,
  playersCreated: false,
  preparing: false,
  preloadComplete: false,
};

function isDevelopment() {
  return typeof __DEV__ !== 'undefined' && __DEV__;
}

function wait(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  let timeout: ReturnType<typeof setTimeout> | null = null;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
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
      currentTime: player.currentTime,
      duration: player.duration,
      id: player.id,
      isBuffering: player.isBuffering,
      isLoaded: player.isLoaded,
      muted: player.muted,
      paused: player.paused,
      playing: player.playing,
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
      volume: player.volume,
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

export function cueAudioLog(event: string, details: Record<string, unknown> = {}) {
  if (!isDevelopment()) {
    return;
  }

  console.log('[SetPace audio]', {
    at: Date.now(),
    audioReady: audioState.audioReady,
    event,
    preloadComplete: audioState.preloadComplete,
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
    audioReady: audioState.audioReady,
    error: serializeError(error),
    event,
    preloadComplete: audioState.preloadComplete,
    ...details,
  });
}

export function getCueAudioState() {
  return { ...audioState };
}

export function isCueAudioReady() {
  return audioState.audioReady && audioState.preloadComplete;
}

export function setCueAudioRunSequence(runSequence: number | null) {
  activeRunSequence = runSequence;
  cueAudioLog('audio run sequence changed', { activeRunSequence });
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

function getCueSources() {
  return (
    cueSources ?? {
      complete: COMPLETE_SOUND,
      countdown: COUNTDOWN_SOUND,
      mark: MARK_SOUND,
      reminder: REMINDER_SOUND,
      start: START_SOUND,
    }
  );
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
    reminder: createAudioPlayer(sources.reminder, PLAYER_OPTIONS),
    start: createAudioPlayer(sources.start, PLAYER_OPTIONS),
  };

  setAudioState({ playersCreated: true });
  cueAudioLog('cue players created', {
    completePlayer: playerState(players.complete),
    countdownPlayer: playerState(players.countdown),
    markPlayer: playerState(players.mark),
    reminderPlayer: playerState(players.reminder),
    startPlayer: playerState(players.start),
  });

  return players;
}

function getPlayers() {
  return players ?? createCuePlayers();
}

function allPlayersLoaded(cuePlayers: CuePlayers) {
  return Object.values(cuePlayers).every((player) => player.isLoaded);
}

async function waitForPlayersLoaded(cuePlayers: CuePlayers, timeoutMs = PLAYER_LOAD_TIMEOUT_MS) {
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

  cueAudioLog('audio player load status timed out; continuing', {
    completePlayer: playerState(cuePlayers.complete),
    countdownPlayer: playerState(cuePlayers.countdown),
    markPlayer: playerState(cuePlayers.mark),
    reminderPlayer: playerState(cuePlayers.reminder),
    startPlayer: playerState(cuePlayers.start),
  });
  return false;
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

  const [complete, countdown, mark, reminder, start] = await Promise.all([
    resolveBundledSound(COMPLETE_SOUND),
    resolveBundledSound(COUNTDOWN_SOUND),
    resolveBundledSound(MARK_SOUND),
    resolveBundledSound(REMINDER_SOUND),
    resolveBundledSound(START_SOUND),
  ]);

  cueSources = {
    complete,
    countdown,
    mark,
    reminder,
    start,
  };

  cueAudioLog('audio assets resolved', {
    complete,
    countdown,
    mark,
    reminder,
    start,
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
      preloadComplete: false,
    });

    await configureAudioSession();
    const sources = await resolveCueSources();
    await Promise.all([
      preloadAsset(sources.start),
      preloadAsset(sources.countdown),
      preloadAsset(sources.mark),
      preloadAsset(sources.reminder),
      preloadAsset(sources.complete),
    ]);

    const cuePlayers = createCuePlayers();
    const allLoaded = await waitForPlayersLoaded(cuePlayers);
    setAudioState({ audioReady: true, lastError: null, preparing: false, preloadComplete: true });
    cueAudioLog('audio preload finished', {
      allLoaded,
      completePlayer: playerState(cuePlayers.complete),
      countdownPlayer: playerState(cuePlayers.countdown),
      markPlayer: playerState(cuePlayers.mark),
      reminderPlayer: playerState(cuePlayers.reminder),
      startPlayer: playerState(cuePlayers.start),
    });
  })();

  try {
    await preloadPromise;
  } catch (error) {
    setAudioState({
      audioReady: false,
      lastError: serializeError(error).message,
      preloadComplete: false,
      preparing: false,
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

export async function prepareAudioBestEffort() {
  if (isCueAudioReady()) {
    return true;
  }

  if (preparePromise !== null) {
    return preparePromise;
  }

  preparePromise = (async () => {
    try {
      setAudioState({ lastError: null, preparing: true });
      await withTimeout(preloadCues(), PREPARE_TIMEOUT_MS, 'Audio preload timed out');
      return isCueAudioReady();
    } catch (error) {
      setAudioState({
        audioReady: false,
        lastError: serializeError(error).message,
        preparing: false,
      });
      cueAudioWarn('audio prepare failed; continuing without sound', error);
      return false;
    } finally {
      setAudioState({ preparing: false });
    }
  })();

  try {
    return await preparePromise;
  } finally {
    preparePromise = null;
  }
}

export function invalidateCueAudio(reason: string) {
  setAudioState({
    audioReady: false,
  });
  cueAudioLog('audio invalidated', { reason });
}

async function playCuePlayer(kind: PlayableCueKind, meta: CueMeta = {}) {
  cueAudioLog(`${kind} cue requested`, {
    ...meta,
    player: playerState(players?.[kind]),
  });

  try {
    if (!isCueMetaCurrent(meta)) {
      cueAudioLog(`${kind} cue skipped for stale run`, {
        ...meta,
        activeRunSequence,
      });
      return false;
    }

    if (!isCueAudioReady()) {
      void prepareAudioBestEffort();
    }

    const player = getPlayers()[kind];
    await resetPlayer(player);

    if (!isCueMetaCurrent(meta)) {
      cueAudioLog(`${kind} cue skipped after reset for stale run`, {
        ...meta,
        activeRunSequence,
      });
      return false;
    }

    player.muted = false;
    player.volume = kind === 'reminder' ? REMINDER_VOLUME : 1;
    player.play();
    cueAudioLog(`${kind} cue play started`, {
      ...meta,
      player: playerState(player),
    });
    return true;
  } catch (error) {
    cueAudioWarn(`${kind} cue play failed`, error, {
      ...meta,
      player: playerState(players?.[kind]),
    });
    return false;
  }
}

export async function playStartCue(meta: CueMeta = {}) {
  return playCuePlayer('start', meta);
}

export async function playCountdownCue(meta: CueMeta = {}) {
  return playCuePlayer('countdown', meta);
}

export async function playMarkCue(meta: CueMeta = {}) {
  return playCuePlayer('mark', meta);
}

export async function playReminderCue(meta: CueMeta = {}) {
  return playCuePlayer('reminder', meta);
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
