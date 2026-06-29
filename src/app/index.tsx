import { useKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import {
  cueAudioLog,
  getCueAudioState,
  invalidateCueAudio,
  isCueAudioReady,
  playCompleteCue,
  playCountdownCue,
  playMarkCue,
  playReminderCue,
  playStartCue,
  prepareAudioBestEffort,
  setCueAudioRunSequence,
  stopAllCues,
} from '@/lib/cueAudio';
import {
  SHORT_BEEP_PREROLL_MS,
  createCueSchedule,
  getDueCueEvents,
  getInitialLeadMs,
  getTotalMs,
  type CueEvent,
  type CueSchedule,
  type LoopCueMode,
  type TimerSettings,
} from '@/lib/cueScheduler';

type TimerStatus = 'idle' | 'readying' | 'running' | 'paused' | 'complete';

type TimerSnapshot = {
  elapsedMs: number;
  currentRepIndex: number;
  timeToNextStartMs: number;
  countdownSecond: number | null;
  upcomingCue: string;
};

type SplitTime = {
  id: number;
  elapsedMs: number;
  repNumber: number;
  repElapsedMs: number;
};

const DEFAULT_SETTINGS: TimerSettings = {
  audioLeadMs: 300,
  countdownSeconds: 5,
  intervalSeconds: 60,
  loopCueMode: 'countdown',
  markHeardLeadMs: 2300,
  reminderEnabled: true,
  reminderSeconds: 5,
  reps: 10,
};

const KEEP_AWAKE_TAG = 'setpace-running-timer';
const MARK_AUDIO_DURATION_MS = 1000;
const MIN_MARK_TO_START_GAP_MS = 500;
const MIN_MARK_HEARD_LEAD_MS = MARK_AUDIO_DURATION_MS + MIN_MARK_TO_START_GAP_MS;

function RunningWakeLock() {
  useKeepAwake(KEEP_AWAKE_TAG);
  return null;
}

function parseWholeNumber(value: string) {
  if (!/^\d+$/.test(value)) {
    return Number.NaN;
  }

  return Number.parseInt(value, 10);
}

function parseSettings(
  values: {
    intervalSeconds: string;
    reps: string;
    reminderSeconds: string;
    countdownSeconds: string;
    audioLeadMs: string;
    markHeardLeadMs: string;
  },
  loopCueMode: LoopCueMode,
  reminderEnabled: boolean
) {
  const intervalSeconds = parseWholeNumber(values.intervalSeconds);
  const reps = parseWholeNumber(values.reps);
  const reminderSeconds = parseWholeNumber(values.reminderSeconds);
  const countdownSeconds = parseWholeNumber(values.countdownSeconds);
  const audioLeadMs = parseWholeNumber(values.audioLeadMs);
  const markHeardLeadMs = parseWholeNumber(values.markHeardLeadMs);
  const errors: string[] = [];

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) {
    errors.push('Interval must be at least 5 seconds.');
  }

  if (!Number.isFinite(reps) || reps < 1) {
    errors.push('Reps must be at least 1.');
  }

  if (reminderEnabled && (!Number.isFinite(reminderSeconds) || reminderSeconds < 1)) {
    errors.push('Reminder must be at least 1 second.');
  }

  if (!Number.isFinite(countdownSeconds) || countdownSeconds < 0) {
    errors.push('Countdown must be 0 seconds or longer.');
  }

  if (!Number.isFinite(audioLeadMs) || audioLeadMs < 0 || audioLeadMs > 800) {
    errors.push('Audio offset must be between 0 and 800ms.');
  }

  if (!Number.isFinite(markHeardLeadMs) || markHeardLeadMs < 1200 || markHeardLeadMs > 4000) {
    errors.push('Take marks lead time must be between 1200 and 4000ms.');
  }

  if (Number.isFinite(markHeardLeadMs) && markHeardLeadMs < MIN_MARK_HEARD_LEAD_MS) {
    errors.push(
      `Take marks lead time must be at least ${MIN_MARK_HEARD_LEAD_MS}ms to avoid overlap.`
    );
  }

  if (
    Number.isFinite(intervalSeconds) &&
    Number.isFinite(countdownSeconds) &&
    countdownSeconds > intervalSeconds
  ) {
    errors.push('Countdown cannot exceed interval duration.');
  }

  if (errors.length > 0) {
    return { errors, settings: null };
  }

  return {
    errors,
    settings: {
      audioLeadMs,
      countdownSeconds,
      intervalSeconds,
      loopCueMode,
      markHeardLeadMs,
      reminderEnabled,
      reminderSeconds:
        Number.isFinite(reminderSeconds) && reminderSeconds >= 1
          ? reminderSeconds
          : DEFAULT_SETTINGS.reminderSeconds,
      reps,
    },
  };
}

function formatClock(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatPreciseClock(ms: number) {
  const safeCentiseconds = Math.max(0, Math.floor(ms / 10));
  const totalSeconds = Math.floor(safeCentiseconds / 100);
  const centiseconds = safeCentiseconds % 100;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(
      2,
      '0'
    )}.${String(centiseconds).padStart(2, '0')}`;
  }

  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(
    2,
    '0'
  )}`;
}

function formatSeconds(ms: number) {
  return `${Math.max(0, Math.ceil(ms / 1000))}s`;
}

function getNextReminderMs(timeIntoCurrentRepMs: number, settings: TimerSettings) {
  if (!settings.reminderEnabled) {
    return null;
  }

  const intervalMs = settings.intervalSeconds * 1000;
  const nextReminderSecond =
    Math.ceil((timeIntoCurrentRepMs / 1000 + 0.001) / settings.reminderSeconds) *
    settings.reminderSeconds;
  const nextReminderMs = nextReminderSecond * 1000;

  if (nextReminderSecond <= 0 || nextReminderMs >= intervalMs) {
    return null;
  }

  return nextReminderMs;
}

function getUpcomingCue(
  timeIntoCurrentRepMs: number,
  timeToNextStartMs: number,
  currentRepIndex: number,
  settings: TimerSettings
) {
  const intervalMs = settings.intervalSeconds * 1000;
  const countdownStartMs = intervalMs - settings.countdownSeconds * 1000;
  const nextReminderMs = getNextReminderMs(timeIntoCurrentRepMs, settings);
  const hasNextRep = currentRepIndex < settings.reps - 1;
  const secondsLeft = Math.max(1, Math.ceil(timeToNextStartMs / 1000));

  if (
    hasNextRep &&
    settings.loopCueMode === 'mark' &&
    timeToNextStartMs <= settings.markHeardLeadMs
  ) {
    return 'Take your marks';
  }

  if (hasNextRep && settings.loopCueMode === 'mark') {
    return `Take your marks in ${formatSeconds(timeToNextStartMs - settings.markHeardLeadMs)}`;
  }

  if (
    hasNextRep &&
    settings.loopCueMode === 'countdown' &&
    settings.countdownSeconds > 0 &&
    secondsLeft <= settings.countdownSeconds
  ) {
    return `Countdown: ${secondsLeft}`;
  }

  if (
    nextReminderMs !== null &&
    (!hasNextRep ||
      settings.loopCueMode !== 'countdown' ||
      settings.countdownSeconds === 0 ||
      nextReminderMs < countdownStartMs)
  ) {
    return `Reminder in ${formatSeconds(nextReminderMs - timeIntoCurrentRepMs)}`;
  }

  if (hasNextRep && settings.loopCueMode === 'countdown' && settings.countdownSeconds > 0) {
    return `Countdown starts in ${formatSeconds(countdownStartMs - timeIntoCurrentRepMs)}`;
  }

  if (hasNextRep) {
    return `Start rep ${currentRepIndex + 2} in ${formatSeconds(timeToNextStartMs)}`;
  }

  return `Set ends in ${formatSeconds(timeToNextStartMs)}`;
}

function buildSnapshot(
  elapsedMs: number,
  settings: TimerSettings,
  status: TimerStatus
): TimerSnapshot {
  const intervalMs = settings.intervalSeconds * 1000;
  const totalMs = getTotalMs(settings);
  const safeElapsedMs = Math.min(Math.max(0, elapsedMs), totalMs);

  if (status === 'complete' || safeElapsedMs >= totalMs) {
    return {
      countdownSecond: null,
      currentRepIndex: settings.reps - 1,
      elapsedMs: totalMs,
      timeToNextStartMs: 0,
      upcomingCue: 'Set complete',
    };
  }

  const currentRepIndex = Math.min(Math.floor(safeElapsedMs / intervalMs), settings.reps - 1);
  const timeIntoCurrentRepMs = safeElapsedMs - currentRepIndex * intervalMs;
  const timeToNextStartMs = intervalMs - timeIntoCurrentRepMs;
  const secondsLeft = Math.max(1, Math.ceil(timeToNextStartMs / 1000));
  const isFinalCountdown =
    settings.loopCueMode === 'countdown' &&
    currentRepIndex < settings.reps - 1 &&
    settings.countdownSeconds > 0 &&
    secondsLeft <= settings.countdownSeconds;

  return {
    countdownSecond: isFinalCountdown ? secondsLeft : null,
    currentRepIndex,
    elapsedMs: safeElapsedMs,
    timeToNextStartMs,
    upcomingCue: getUpcomingCue(
      timeIntoCurrentRepMs,
      timeToNextStartMs,
      currentRepIndex,
      settings
    ),
  };
}

function sanitizeDigits(value: string) {
  return value.replace(/[^\d]/g, '');
}

function getRunCueKey(runSequence: number, event: CueEvent) {
  return `${runSequence}:${event.key}`;
}

export default function HomeScreen() {
  const [status, setStatus] = useState<TimerStatus>('idle');
  const [audioReady, setAudioReady] = useState(isCueAudioReady());
  const [audioStatusText, setAudioStatusText] = useState(
    isCueAudioReady() ? 'Audio ready' : 'Preparing sound'
  );
  const [intervalSeconds, setIntervalSeconds] = useState(String(DEFAULT_SETTINGS.intervalSeconds));
  const [reps, setReps] = useState(String(DEFAULT_SETTINGS.reps));
  const [reminderEnabled, setReminderEnabled] = useState(DEFAULT_SETTINGS.reminderEnabled);
  const [reminderSeconds, setReminderSeconds] = useState(String(DEFAULT_SETTINGS.reminderSeconds));
  const [countdownSeconds, setCountdownSeconds] = useState(String(DEFAULT_SETTINGS.countdownSeconds));
  const [audioLeadMs, setAudioLeadMs] = useState(String(DEFAULT_SETTINGS.audioLeadMs));
  const [markHeardLeadMs, setMarkHeardLeadMs] = useState(
    String(DEFAULT_SETTINGS.markHeardLeadMs)
  );
  const [loopCueMode, setLoopCueMode] = useState<LoopCueMode>(DEFAULT_SETTINGS.loopCueMode);
  const [activeSettings, setActiveSettings] = useState<TimerSettings | null>(null);
  const [snapshot, setSnapshot] = useState<TimerSnapshot>(() =>
    buildSnapshot(0, DEFAULT_SETTINGS, 'idle')
  );
  const [splits, setSplits] = useState<SplitTime[]>([]);
  const [preStartCountdownSecond, setPreStartCountdownSecond] = useState<number | null>(null);
  const [cueText, setCueText] = useState('Ready');
  const [audioDiagnosticsOpen, setAudioDiagnosticsOpen] = useState(false);
  const [audioDiagnosticLastPressed, setAudioDiagnosticLastPressed] = useState('None');
  const [audioDiagnosticResult, setAudioDiagnosticResult] = useState('No test run');
  const [audioDiagnosticDetails, setAudioDiagnosticDetails] = useState(() => getCueAudioState());

  const startedAtRef = useRef<number | null>(null);
  const pausedElapsedMsRef = useRef(0);
  const frameRef = useRef<number | null>(null);
  const activeSettingsRef = useRef<TimerSettings | null>(null);
  const activeCueScheduleRef = useRef<CueSchedule | null>(null);
  const firedCueKeysRef = useRef<Set<string>>(new Set());
  const skippedCueKeysRef = useRef<Set<string>>(new Set());
  const completeCueFiredRef = useRef(false);
  const appStateRef = useRef(AppState.currentState);
  const runSequenceRef = useRef(0);
  const splitCounterRef = useRef(0);

  const parsed = useMemo(
    () =>
      parseSettings(
        {
          audioLeadMs,
          countdownSeconds,
          intervalSeconds,
          markHeardLeadMs,
          reminderSeconds,
          reps,
        },
        loopCueMode,
        reminderEnabled
      ),
    [
      audioLeadMs,
      countdownSeconds,
      intervalSeconds,
      loopCueMode,
      markHeardLeadMs,
      reminderEnabled,
      reminderSeconds,
      reps,
    ]
  );

  const displayedSettings = activeSettings ?? parsed.settings ?? DEFAULT_SETTINGS;
  const controlsLocked = status === 'readying' || status === 'running' || status === 'paused';
  const canStart = !controlsLocked && parsed.settings !== null;
  const isStarted =
    status === 'readying' ||
    status === 'running' ||
    status === 'paused' ||
    status === 'complete';
  const canSplit = (status === 'running' || status === 'paused') && activeSettings !== null;
  const currentRepNumber =
    status === 'idle' ? 1 : Math.min(snapshot.currentRepIndex + 1, displayedSettings.reps);
  const countdownDisplay =
    status === 'readying'
      ? preStartCountdownSecond === null
        ? displayedSettings.loopCueMode === 'mark'
          ? 'Mark'
          : 'Start'
        : String(preStartCountdownSecond)
      : status === 'complete'
        ? 'Done'
        : snapshot.countdownSecond !== null
          ? String(snapshot.countdownSecond)
          : formatClock(Math.ceil(snapshot.timeToNextStartMs / 1000));
  const statusText =
    status === 'readying'
      ? displayedSettings.loopCueMode === 'countdown'
        ? 'COUNTDOWN'
        : 'ON MARKS'
      : status.toUpperCase();
  const upcomingCueText =
    status === 'readying'
      ? displayedSettings.loopCueMode === 'countdown'
        ? 'Start rep 1 after countdown'
        : 'Start rep 1 after Take your marks'
      : snapshot.upcomingCue;
  const intervalMs = displayedSettings.intervalSeconds * 1000;
  const loopElapsedMs = Math.min(
    intervalMs,
    Math.max(0, snapshot.elapsedMs - snapshot.currentRepIndex * intervalMs)
  );
  const loopTimeDisplay = formatPreciseClock(loopElapsedMs);
  const elapsedDisplay = formatClock(Math.floor(snapshot.elapsedMs / 1000));
  const repProgress = status === 'complete' ? 1 : 1 - snapshot.timeToNextStartMs / intervalMs;

  const refreshAudioStatus = useCallback(() => {
    const cueAudioState = getCueAudioState();
    const ready = isCueAudioReady();

    setAudioDiagnosticDetails(cueAudioState);
    setAudioReady(ready);
    setAudioStatusText(
      ready
        ? 'Audio ready'
        : cueAudioState.lastError
          ? 'Sound unavailable'
          : 'Preparing sound'
    );

    return ready;
  }, []);

  const prepareCueAudio = useCallback(async () => {
    setAudioStatusText('Preparing sound');

    try {
      await prepareAudioBestEffort();
      return refreshAudioStatus();
    } catch {
      return refreshAudioStatus();
    }
  }, [refreshAudioStatus]);

  const dispatchScheduledCue = useCallback((event: CueEvent, runSequence: number) => {
    const runCueKey = getRunCueKey(runSequence, event);

    if (firedCueKeysRef.current.has(runCueKey) || skippedCueKeysRef.current.has(runCueKey)) {
      return;
    }

    setCueText(event.text);

    if (Platform.OS === 'android' && event.vibrationMs > 0) {
      Vibration.vibrate(event.vibrationMs);
    }

    try {
      if (event.kind === 'start') {
        void playStartCue({
          cueKey: event.key,
          repIndex: event.repIndex,
          runSequence,
        });
      } else if (event.kind === 'countdown') {
        void playCountdownCue({
          cueKey: event.key,
          repIndex: event.repIndex,
          runSequence,
        });
      } else if (event.kind === 'mark') {
        void playMarkCue({
          cueKey: event.key,
          repIndex: event.repIndex,
          runSequence,
        });
      } else {
        void playReminderCue({
          cueKey: event.key,
          repIndex: event.repIndex,
          runSequence,
        });
      }
    } catch (error) {
      cueAudioLog('cue dispatch threw synchronously', {
        cueKey: event.key,
        error: String(error),
        kind: event.kind,
        runSequence,
      });
    }

    firedCueKeysRef.current.add(runCueKey);
  }, []);

  const processDueCueEvents = useCallback(
    (now: number, schedule: CueSchedule) => {
      const isHandled = (event: CueEvent) => {
        const runCueKey = getRunCueKey(schedule.runSequence, event);
        return (
          firedCueKeysRef.current.has(runCueKey) || skippedCueKeysRef.current.has(runCueKey)
        );
      };
      const { due, expired } = getDueCueEvents(schedule, now, isHandled);

      expired.forEach((event) => {
        const runCueKey = getRunCueKey(schedule.runSequence, event);
        skippedCueKeysRef.current.add(runCueKey);
        cueAudioLog('cue skipped after expiry', {
          cueKey: event.key,
          expiresAt: event.expiresAt,
          fireAt: event.fireAt,
          kind: event.kind,
          now,
          runSequence: schedule.runSequence,
        });
      });

      due.forEach((event) => {
        dispatchScheduledCue(event, schedule.runSequence);
      });
    },
    [dispatchScheduledCue]
  );

  const dispatchCompleteCue = useCallback(() => {
    if (completeCueFiredRef.current) {
      return;
    }

    completeCueFiredRef.current = true;
    setCueText('Set complete');

    if (Platform.OS === 'android') {
      Vibration.vibrate(180);
    }

    void playCompleteCue({
      cueKey: 'complete',
      runSequence: runSequenceRef.current,
    });
  }, []);

  useEffect(() => {
    const timeout = setTimeout(() => {
      void prepareCueAudio();
    }, 0);

    return () => {
      clearTimeout(timeout);
    };
  }, [prepareCueAudio]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      const previousState = appStateRef.current;
      const wasBackgrounded = previousState.match(/inactive|background/);

      cueAudioLog('app state changed', { nextState, previousState });
      appStateRef.current = nextState;

      if (!wasBackgrounded || nextState !== 'active') {
        return;
      }

      invalidateCueAudio('app-foreground');
      void prepareCueAudio();
    });

    return () => {
      subscription.remove();
    };
  }, [prepareCueAudio]);

  useEffect(() => {
    if (status === 'idle') {
      const timeout = setTimeout(() => {
        setSnapshot(buildSnapshot(0, parsed.settings ?? DEFAULT_SETTINGS, 'idle'));
      }, 0);

      return () => {
        clearTimeout(timeout);
      };
    }
  }, [parsed.settings, status]);

  const clearIdleCueState = useCallback(() => {
    if (status === 'readying' || status === 'running' || status === 'paused') {
      return;
    }

    activeCueScheduleRef.current = null;
    firedCueKeysRef.current.clear();
    skippedCueKeysRef.current.clear();
    completeCueFiredRef.current = false;
    setPreStartCountdownSecond(null);
    stopAllCues();
    Vibration.cancel();

    if (status === 'complete') {
      activeSettingsRef.current = null;
      setActiveSettings(null);
      startedAtRef.current = null;
      pausedElapsedMsRef.current = 0;
      splitCounterRef.current = 0;
      setSplits([]);
      setCueText('Ready');
      setStatus('idle');
    }
  }, [status]);

  const updateInput = useCallback(
    (setter: (value: string) => void) => (value: string) => {
      if (controlsLocked) {
        return;
      }

      clearIdleCueState();
      setter(sanitizeDigits(value));
    },
    [clearIdleCueState, controlsLocked]
  );

  const getRunningElapsedMs = useCallback((settings: TimerSettings) => {
    const baseElapsedMs =
      startedAtRef.current === null ? pausedElapsedMsRef.current : Date.now() - startedAtRef.current;

    return Math.min(Math.max(0, baseElapsedMs), getTotalMs(settings));
  }, []);

  const getRawElapsedMs = useCallback(() => {
    return startedAtRef.current === null ? pausedElapsedMsRef.current : Date.now() - startedAtRef.current;
  }, []);

  useEffect(() => {
    if (status !== 'readying' && status !== 'running') {
      return;
    }

    let active = true;

    const tick = () => {
      const settings = activeSettingsRef.current;
      const schedule = activeCueScheduleRef.current;

      if (!active || settings === null || schedule === null) {
        return;
      }

      const now = Date.now();
      const rawElapsedMs = getRawElapsedMs();
      const totalMs = getTotalMs(settings);
      const elapsedMs = Math.min(Math.max(0, rawElapsedMs), totalMs);

      if (rawElapsedMs < 0) {
        if (settings.loopCueMode === 'countdown' && settings.countdownSeconds > 0) {
          const visiblePreStartMs = Math.max(0, Math.abs(rawElapsedMs) - settings.audioLeadMs);
          setPreStartCountdownSecond(Math.max(1, Math.ceil(visiblePreStartMs / 1000)));
        } else {
          setPreStartCountdownSecond(null);
        }
      } else if (status === 'readying') {
        setPreStartCountdownSecond(null);
        setStatus('running');
      }

      processDueCueEvents(now, schedule);

      if (elapsedMs >= totalMs) {
        pausedElapsedMsRef.current = totalMs;
        startedAtRef.current = null;
        activeCueScheduleRef.current = null;
        setSnapshot(buildSnapshot(totalMs, settings, 'complete'));
        dispatchCompleteCue();
        setStatus('complete');
        return;
      }

      setSnapshot(buildSnapshot(elapsedMs, settings, rawElapsedMs < 0 ? 'readying' : 'running'));
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);

    return () => {
      active = false;

      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [dispatchCompleteCue, getRawElapsedMs, processDueCueEvents, status]);

  const startSet = useCallback(() => {
    const settings = parsed.settings;

    if (settings === null) {
      return;
    }

    const now = Date.now();
    const runSequence = runSequenceRef.current + 1;
    const intendedStartAt = now + getInitialLeadMs(settings);
    const schedule = createCueSchedule({
      runSequence,
      settings,
      startedAt: intendedStartAt,
    });

    runSequenceRef.current = runSequence;
    setCueAudioRunSequence(runSequence);
    Vibration.cancel();
    firedCueKeysRef.current.clear();
    skippedCueKeysRef.current.clear();
    completeCueFiredRef.current = false;
    activeSettingsRef.current = settings;
    activeCueScheduleRef.current = schedule;
    startedAtRef.current = intendedStartAt;
    pausedElapsedMsRef.current = 0;
    splitCounterRef.current = 0;
    setActiveSettings(settings);
    setSplits([]);
    setSnapshot(buildSnapshot(0, settings, 'readying'));
    setPreStartCountdownSecond(
      settings.loopCueMode === 'countdown' && settings.countdownSeconds > 0
        ? settings.countdownSeconds
        : null
    );
    setCueText('Ready');
    setStatus('readying');

    void prepareCueAudio();
  }, [parsed.settings, prepareCueAudio]);

  const pauseSet = useCallback(() => {
    const settings = activeSettingsRef.current;

    if (status !== 'running' || settings === null) {
      return;
    }

    const elapsedMs = getRunningElapsedMs(settings);
    pausedElapsedMsRef.current = elapsedMs;
    startedAtRef.current = null;
    activeCueScheduleRef.current = null;
    setSnapshot(buildSnapshot(elapsedMs, settings, 'paused'));
    setCueText('Paused');
    setStatus('paused');
  }, [getRunningElapsedMs, status]);

  const resumeSet = useCallback(() => {
    const settings = activeSettingsRef.current;

    if (status !== 'paused' || settings === null) {
      return;
    }

    const resumedStartAt = Date.now() - pausedElapsedMsRef.current;
    const schedule = createCueSchedule({
      runSequence: runSequenceRef.current,
      settings,
      startedAt: resumedStartAt,
    });

    startedAtRef.current = resumedStartAt;
    pausedElapsedMsRef.current = 0;
    activeCueScheduleRef.current = schedule;
    setCueText('Resumed');
    setStatus('running');
  }, [status]);

  const resetSet = useCallback(() => {
    const nextSettings = parsed.settings ?? DEFAULT_SETTINGS;

    runSequenceRef.current += 1;
    setCueAudioRunSequence(runSequenceRef.current);
    startedAtRef.current = null;
    activeSettingsRef.current = null;
    activeCueScheduleRef.current = null;
    pausedElapsedMsRef.current = 0;
    firedCueKeysRef.current.clear();
    skippedCueKeysRef.current.clear();
    completeCueFiredRef.current = false;
    splitCounterRef.current = 0;
    stopAllCues();
    Vibration.cancel();
    setActiveSettings(null);
    setSplits([]);
    setSnapshot(buildSnapshot(0, nextSettings, 'idle'));
    setPreStartCountdownSecond(null);
    setCueText('Ready');
    refreshAudioStatus();
    setStatus('idle');
  }, [parsed.settings, refreshAudioStatus]);

  const updateLoopCueMode = useCallback(
    (mode: LoopCueMode) => {
      if (controlsLocked) {
        return;
      }

      clearIdleCueState();
      setLoopCueMode(mode);
    },
    [clearIdleCueState, controlsLocked]
  );

  const updateReminderEnabled = useCallback(
    (enabled: boolean) => {
      if (controlsLocked) {
        return;
      }

      clearIdleCueState();
      setReminderEnabled(enabled);
    },
    [clearIdleCueState, controlsLocked]
  );

  const recordSplit = useCallback(() => {
    const settings = activeSettingsRef.current;

    if ((status !== 'running' && status !== 'paused') || settings === null) {
      return;
    }

    const elapsedMs = getRunningElapsedMs(settings);
    const intervalMs = settings.intervalSeconds * 1000;
    const repIndex = Math.min(Math.floor(elapsedMs / intervalMs), settings.reps - 1);
    const splitId = splitCounterRef.current + 1;

    splitCounterRef.current = splitId;
    setSplits((currentSplits) => [
      {
        elapsedMs,
        id: splitId,
        repElapsedMs: elapsedMs - repIndex * intervalMs,
        repNumber: repIndex + 1,
      },
      ...currentSplits,
    ]);
    setCueText(`Split ${splitId}`);
  }, [getRunningElapsedMs, status]);

  const playAudioDiagnosticCue = useCallback(
    (
      label: string,
      playCue: () => Promise<boolean>,
      resultPrefix = label
    ) => {
      setAudioDiagnosticLastPressed(label);
      setAudioDiagnosticResult('Preparing sound...');
      void prepareCueAudio();
      void playCue()
        .then((result) => {
          refreshAudioStatus();
          setAudioDiagnosticResult(`${resultPrefix}: ${String(result)}`);
        })
        .catch((error) => {
          refreshAudioStatus();
          setAudioDiagnosticResult(`${resultPrefix}: failed (${String(error)})`);
        });
    },
    [prepareCueAudio, refreshAudioStatus]
  );

  const playAudioDiagnosticCueTwice = useCallback(
    (label: string, playCue: () => Promise<boolean>) => {
      const results: string[] = [];
      setAudioDiagnosticLastPressed(label);
      setAudioDiagnosticResult('Preparing sound...');

      const runCue = (index: number) => {
        void prepareCueAudio();
        void playCue()
          .then((result) => {
            results[index] = String(result);
            refreshAudioStatus();
            setAudioDiagnosticResult(`${label}: ${results.filter(Boolean).join(', ')}`);
          })
          .catch((error) => {
            results[index] = `failed (${String(error)})`;
            refreshAudioStatus();
            setAudioDiagnosticResult(`${label}: ${results.filter(Boolean).join(', ')}`);
          });
      };

      runCue(0);
      setTimeout(() => runCue(1), 650);
    },
    [prepareCueAudio, refreshAudioStatus]
  );

  return (
    <View style={styles.screen}>
      {(status === 'readying' || status === 'running') && <RunningWakeLock />}
      <SafeAreaView style={styles.safeArea}>
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          keyboardVerticalOffset={0}
          style={styles.keyboardAvoider}>
          <ScrollView
            contentContainerStyle={styles.content}
            keyboardDismissMode="on-drag"
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}>
            <View style={styles.header}>
              <Text style={styles.brand}>SetPace</Text>
              <View style={styles.headerMeta}>
                <Text style={styles.statusLabel}>{statusText}</Text>
                <Text style={[styles.audioStatus, audioReady && styles.audioStatusReady]}>
                  {audioStatusText}
                </Text>
              </View>
            </View>

            <View style={styles.timerPanel}>
              <Text style={styles.timerLabel}>Loop time</Text>
              <Text adjustsFontSizeToFit numberOfLines={1} style={styles.countdown}>
                {loopTimeDisplay}
              </Text>

              <View style={styles.progressTrack}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.min(1, Math.max(0, repProgress)) * 100}%` },
                  ]}
                />
              </View>

              <View style={styles.repRow}>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Rep</Text>
                  <Text style={styles.metricValue}>
                    {currentRepNumber}/{displayedSettings.reps}
                  </Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Next start</Text>
                  <Text
                    style={[
                      styles.metricValue,
                      (snapshot.countdownSecond !== null || preStartCountdownSecond !== null) &&
                        styles.metricUrgent,
                    ]}>
                    {countdownDisplay}
                  </Text>
                </View>
                <View style={styles.metric}>
                  <Text style={styles.metricLabel}>Elapsed</Text>
                  <Text style={styles.metricValue}>{elapsedDisplay}</Text>
                </View>
              </View>

              <View style={styles.cuePanel}>
                <Text style={styles.cueLabel}>Cue</Text>
                <Text style={styles.cueText}>{cueText}</Text>
                <Text style={styles.nextCue}>{upcomingCueText}</Text>
              </View>
            </View>

            <View style={styles.controlRow}>
              {status === 'running' ? (
                <ControlButton label="Pause" onPress={pauseSet} variant="secondary" />
              ) : status === 'paused' ? (
                <ControlButton label="Resume" onPress={resumeSet} variant="primary" />
              ) : status === 'readying' ? (
                <ControlButton
                  disabled
                  label={displayedSettings.loopCueMode === 'countdown' ? 'Counting' : 'Mark'}
                  onPress={() => undefined}
                  variant="secondary"
                />
              ) : (
                <ControlButton
                  disabled={!canStart}
                  label="Start"
                  onPress={startSet}
                  variant="primary"
                />
              )}
              <ControlButton
                disabled={!canSplit}
                label="Split"
                onPress={recordSplit}
                variant="secondary"
              />
              <ControlButton
                disabled={!isStarted && status === 'idle'}
                label="Reset"
                onPress={resetSet}
                variant="danger"
              />
            </View>

            {splits.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Splits</Text>
                <View style={styles.splitList}>
                  {splits.map((split) => (
                    <View key={split.id} style={styles.splitRow}>
                      <View>
                        <Text style={styles.splitLabel}>Split {split.id}</Text>
                        <Text style={styles.splitMeta}>Rep {split.repNumber}</Text>
                      </View>
                      <Text style={styles.splitTime}>{formatPreciseClock(split.repElapsedMs)}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Loop start cue</Text>
              <View style={styles.segmentedControl}>
                <ModeButton
                  disabled={controlsLocked}
                  label="Countdown"
                  onPress={() => updateLoopCueMode('countdown')}
                  selected={loopCueMode === 'countdown'}
                />
                <ModeButton
                  disabled={controlsLocked}
                  label="Take marks"
                  onPress={() => updateLoopCueMode('mark')}
                  selected={loopCueMode === 'mark'}
                />
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Set</Text>
              <View style={styles.toggleRow}>
                <View style={styles.toggleCopy}>
                  <Text style={styles.toggleTitle}>Reminder</Text>
                  <Text style={styles.toggleValue}>
                    {reminderEnabled
                      ? `Every ${reminderSeconds || DEFAULT_SETTINGS.reminderSeconds}s`
                      : 'Off'}
                  </Text>
                </View>
                <Switch
                  disabled={controlsLocked}
                  onValueChange={updateReminderEnabled}
                  thumbColor={reminderEnabled ? '#f7fff9' : '#6f817b'}
                  trackColor={{ false: '#22302c', true: '#31d67b' }}
                  value={reminderEnabled}
                />
              </View>
              <View style={styles.settingsGrid}>
                <SettingInput
                  editable={!controlsLocked}
                  label="Interval"
                  onChangeText={updateInput(setIntervalSeconds)}
                  unit="sec"
                  value={intervalSeconds}
                />
                <SettingInput
                  editable={!controlsLocked}
                  label="Reps"
                  onChangeText={updateInput(setReps)}
                  unit="reps"
                  value={reps}
                />
                <SettingInput
                  editable={!controlsLocked && reminderEnabled}
                  label="Reminder"
                  onChangeText={updateInput(setReminderSeconds)}
                  unit="sec"
                  value={reminderSeconds}
                />
                <SettingInput
                  editable={!controlsLocked}
                  label="Countdown"
                  onChangeText={updateInput(setCountdownSeconds)}
                  unit="sec"
                  value={countdownSeconds}
                />
              </View>

              <Text style={styles.subsectionTitle}>Audio timing</Text>
              <View style={styles.settingsGrid}>
                <SettingInput
                  editable={!controlsLocked}
                  helper="Increase if Bluetooth speaker sounds late."
                  label="Audio offset"
                  onChangeText={updateInput(setAudioLeadMs)}
                  unit="ms"
                  value={audioLeadMs}
                />
                <SettingInput
                  editable={!controlsLocked}
                  helper="Increase if Take your marks overlaps with the start beep."
                  label="Take marks lead"
                  onChangeText={updateInput(setMarkHeardLeadMs)}
                  unit="ms"
                  value={markHeardLeadMs}
                />
              </View>

              {parsed.errors.length > 0 && (
                <View style={styles.errorBox}>
                  {parsed.errors.map((error) => (
                    <Text key={error} style={styles.errorText}>
                      {error}
                    </Text>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.diagnosticsPanel}>
              <Pressable
                accessibilityRole="button"
                onPress={() => setAudioDiagnosticsOpen((isOpen) => !isOpen)}
                style={({ pressed }) => [
                  styles.diagnosticsHeader,
                  pressed && styles.pressed,
                ]}>
                <View>
                  <Text style={styles.sectionTitle}>Audio diagnostics</Text>
                  <Text style={styles.diagnosticsSubtitle}>For testing only</Text>
                </View>
                <Text style={styles.diagnosticsToggle}>
                  {audioDiagnosticsOpen ? 'Hide' : 'Show'}
                </Text>
              </Pressable>

              {audioDiagnosticsOpen && (
                <View style={styles.diagnosticsBody}>
                  <Text style={styles.diagnosticsStatus}>
                    Last pressed: {audioDiagnosticLastPressed}
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    Play result: {audioDiagnosticResult}
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    Current audio status: {audioStatusText}
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    Short beep pre-roll: {SHORT_BEEP_PREROLL_MS}ms
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    audioReady: {String(audioDiagnosticDetails.audioReady)}
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    preloadComplete: {String(audioDiagnosticDetails.preloadComplete)}
                  </Text>
                  <Text style={styles.diagnosticsStatus}>
                    lastError: {audioDiagnosticDetails.lastError ?? 'none'}
                  </Text>

                  <View style={styles.diagnosticsButtonRow}>
                    <ControlButton
                      label="Test start"
                      onPress={() =>
                        playAudioDiagnosticCue('Test start', () =>
                          playStartCue({ cueKey: 'manual-start-test' })
                        )
                      }
                      variant="secondary"
                    />
                    <ControlButton
                      label="Test countdown"
                      onPress={() =>
                        playAudioDiagnosticCue('Test countdown', () =>
                          playCountdownCue({ cueKey: 'manual-countdown-test' })
                        )
                      }
                      variant="secondary"
                    />
                  </View>
                  <View style={styles.diagnosticsButtonRow}>
                    <ControlButton
                      label="Test reminder"
                      onPress={() =>
                        playAudioDiagnosticCue('Test reminder', () =>
                          playReminderCue({ cueKey: 'manual-reminder-test' })
                        )
                      }
                      variant="secondary"
                    />
                    <ControlButton
                      label="Test marks"
                      onPress={() =>
                        playAudioDiagnosticCue('Test marks', () =>
                          playMarkCue({ cueKey: 'manual-mark-test' })
                        )
                      }
                      variant="secondary"
                    />
                  </View>
                  <View style={styles.diagnosticsButtonRow}>
                    <ControlButton
                      label="Test start x2"
                      onPress={() =>
                        playAudioDiagnosticCueTwice('Test start x2', () =>
                          playStartCue({ cueKey: 'manual-start-test' })
                        )
                      }
                      variant="secondary"
                    />
                    <ControlButton
                      label="Test countdown x2"
                      onPress={() =>
                        playAudioDiagnosticCueTwice('Test countdown x2', () =>
                          playCountdownCue({ cueKey: 'manual-countdown-test' })
                        )
                      }
                      variant="secondary"
                    />
                  </View>
                  <View style={styles.diagnosticsButtonRow}>
                    <ControlButton
                      label="Test reminder x2"
                      onPress={() =>
                        playAudioDiagnosticCueTwice('Test reminder x2', () =>
                          playReminderCue({ cueKey: 'manual-reminder-test' })
                        )
                      }
                      variant="secondary"
                    />
                  </View>
                </View>
              )}
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

function ControlButton({
  disabled = false,
  label,
  onPress,
  variant,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary' | 'danger';
}) {
  const variantStyle =
    variant === 'primary'
      ? styles.primaryButton
      : variant === 'secondary'
        ? styles.secondaryButton
        : styles.dangerButton;
  const textStyle = variant === 'danger' ? styles.dangerButtonText : styles.controlButtonText;

  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.controlButton,
        variantStyle,
        disabled && styles.disabledButton,
        pressed && styles.pressed,
      ]}>
      <Text
        adjustsFontSizeToFit
        numberOfLines={1}
        style={[textStyle, disabled && styles.disabledText]}>
        {label}
      </Text>
    </Pressable>
  );
}

function ModeButton({
  disabled,
  label,
  onPress,
  selected,
}: {
  disabled: boolean;
  label: string;
  onPress: () => void;
  selected: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.modeButton,
        selected && styles.modeButtonSelected,
        disabled && styles.disabledSurface,
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.modeButtonText, selected && styles.modeButtonTextSelected]}>
        {label}
      </Text>
    </Pressable>
  );
}

function SettingInput({
  editable,
  helper,
  label,
  onChangeText,
  unit,
  value,
}: {
  editable: boolean;
  helper?: string;
  label: string;
  onChangeText: (value: string) => void;
  unit: string;
  value: string;
}) {
  return (
    <View style={[styles.settingBox, !editable && styles.disabledSurface]}>
      <Text style={styles.inputLabel}>{label}</Text>
      <View style={styles.inputRow}>
        <TextInput
          editable={editable}
          inputMode="numeric"
          keyboardType="number-pad"
          maxLength={4}
          onChangeText={onChangeText}
          selectTextOnFocus
          style={[styles.input, !editable && styles.disabledText]}
          value={value}
        />
        <Text style={styles.unit}>{unit}</Text>
      </View>
      {helper !== undefined && <Text style={styles.inputHelper}>{helper}</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  audioStatus: {
    color: '#ffcc66',
    fontSize: 11,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  audioStatusReady: {
    color: '#88f0b6',
  },
  brand: {
    color: '#f7fff9',
    fontSize: 28,
    fontWeight: '800',
  },
  content: {
    alignSelf: 'center',
    flexGrow: 1,
    gap: 18,
    maxWidth: 680,
    paddingBottom: 120,
    paddingHorizontal: 18,
    paddingTop: 12,
    width: '100%',
  },
  controlButton: {
    alignItems: 'center',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 58,
    paddingHorizontal: 16,
  },
  controlButtonText: {
    color: '#07100f',
    fontSize: 18,
    fontWeight: '900',
  },
  controlRow: {
    flexDirection: 'row',
    gap: 12,
  },
  countdown: {
    color: '#f7fff9',
    fontSize: 86,
    fontWeight: '900',
    lineHeight: 96,
    textAlign: 'center',
  },
  cueLabel: {
    color: '#4fc3ff',
    fontSize: 12,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  cuePanel: {
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    padding: 12,
  },
  cueText: {
    color: '#f7fff9',
    fontSize: 24,
    fontWeight: '800',
    marginTop: 4,
  },
  dangerButton: {
    backgroundColor: '#281717',
    borderColor: '#ff6464',
    borderWidth: 1,
  },
  dangerButtonText: {
    color: '#ff8f8f',
    fontSize: 18,
    fontWeight: '900',
  },
  diagnosticsBody: {
    gap: 8,
  },
  diagnosticsButtonRow: {
    flexDirection: 'row',
    gap: 8,
  },
  diagnosticsHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  diagnosticsPanel: {
    backgroundColor: '#111f1b',
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    gap: 10,
    padding: 12,
  },
  diagnosticsStatus: {
    color: '#dff8eb',
    fontSize: 13,
    fontWeight: '700',
  },
  diagnosticsSubtitle: {
    color: '#9fb3ad',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  diagnosticsToggle: {
    color: '#4fc3ff',
    fontSize: 13,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  disabledButton: {
    backgroundColor: '#22302c',
    borderColor: '#2c3c37',
  },
  disabledSurface: {
    opacity: 0.45,
  },
  disabledText: {
    color: '#6f817b',
  },
  errorBox: {
    backgroundColor: '#271914',
    borderColor: '#ff9e64',
    borderRadius: 8,
    borderWidth: 1,
    gap: 4,
    padding: 12,
  },
  errorText: {
    color: '#ffbd8c',
    fontSize: 14,
    fontWeight: '700',
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  headerMeta: {
    alignItems: 'flex-end',
    gap: 5,
  },
  input: {
    color: '#f7fff9',
    flex: 1,
    fontSize: 28,
    fontWeight: '900',
    minHeight: 44,
    padding: 0,
  },
  inputHelper: {
    color: '#9fb3ad',
    fontSize: 11,
    fontWeight: '600',
    lineHeight: 15,
    marginTop: 6,
  },
  inputLabel: {
    color: '#9fb3ad',
    fontSize: 13,
    fontWeight: '800',
    textTransform: 'uppercase',
  },
  inputRow: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    gap: 8,
    marginTop: 4,
  },
  keyboardAvoider: {
    flex: 1,
  },
  metric: {
    backgroundColor: '#15241f',
    borderRadius: 8,
    flex: 1,
    justifyContent: 'center',
    minHeight: 76,
    padding: 10,
  },
  metricLabel: {
    color: '#9fb3ad',
    fontSize: 12,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  metricUrgent: {
    color: '#ffcc66',
  },
  metricValue: {
    color: '#f7fff9',
    fontSize: 20,
    fontWeight: '800',
    marginTop: 5,
  },
  modeButton: {
    alignItems: 'center',
    borderRadius: 6,
    flex: 1,
    justifyContent: 'center',
    minHeight: 48,
    paddingHorizontal: 10,
  },
  modeButtonSelected: {
    backgroundColor: '#31d67b',
  },
  modeButtonText: {
    color: '#dff8eb',
    fontSize: 15,
    fontWeight: '800',
  },
  modeButtonTextSelected: {
    color: '#07100f',
  },
  nextCue: {
    color: '#9fb3ad',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 4,
  },
  pressed: {
    opacity: 0.78,
  },
  primaryButton: {
    backgroundColor: '#31d67b',
  },
  progressFill: {
    backgroundColor: '#31d67b',
    height: '100%',
  },
  progressTrack: {
    backgroundColor: '#1a2a25',
    borderRadius: 4,
    height: 8,
    overflow: 'hidden',
  },
  repRow: {
    flexDirection: 'row',
    gap: 10,
  },
  safeArea: {
    flex: 1,
  },
  screen: {
    backgroundColor: '#07100f',
    flex: 1,
  },
  secondaryButton: {
    backgroundColor: '#4fc3ff',
  },
  section: {
    gap: 10,
  },
  sectionTitle: {
    color: '#f7fff9',
    fontSize: 16,
    fontWeight: '800',
  },
  segmentedControl: {
    backgroundColor: '#111f1b',
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 6,
    padding: 6,
  },
  settingBox: {
    backgroundColor: '#111f1b',
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    flexBasis: '47%',
    flexGrow: 1,
    minHeight: 88,
    minWidth: 150,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  settingsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
  },
  splitLabel: {
    color: '#f7fff9',
    fontSize: 15,
    fontWeight: '800',
  },
  splitList: {
    gap: 8,
  },
  splitMeta: {
    color: '#9fb3ad',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  splitRow: {
    alignItems: 'center',
    backgroundColor: '#111f1b',
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  splitTime: {
    color: '#88f0b6',
    fontSize: 18,
    fontWeight: '900',
  },
  statusLabel: {
    backgroundColor: '#16241f',
    borderColor: '#28443a',
    borderRadius: 6,
    borderWidth: 1,
    color: '#88f0b6',
    fontSize: 12,
    fontWeight: '800',
    letterSpacing: 0,
    overflow: 'hidden',
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  subsectionTitle: {
    color: '#9fb3ad',
    fontSize: 13,
    fontWeight: '800',
    marginTop: 4,
    textTransform: 'uppercase',
  },
  timerLabel: {
    color: '#9fb3ad',
    fontSize: 14,
    fontWeight: '700',
    textAlign: 'center',
    textTransform: 'uppercase',
  },
  timerPanel: {
    backgroundColor: '#0f1b18',
    borderColor: '#243b34',
    borderRadius: 8,
    borderWidth: 1,
    gap: 16,
    padding: 18,
  },
  toggleCopy: {
    flex: 1,
    paddingRight: 12,
  },
  toggleRow: {
    alignItems: 'center',
    backgroundColor: '#111f1b',
    borderColor: '#28443a',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 58,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  toggleTitle: {
    color: '#f7fff9',
    fontSize: 15,
    fontWeight: '800',
  },
  toggleValue: {
    color: '#9fb3ad',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  unit: {
    color: '#4fc3ff',
    fontSize: 14,
    fontWeight: '800',
    paddingBottom: 7,
  },
});
