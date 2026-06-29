export type LoopCueMode = 'countdown' | 'mark';

export type TimerSettings = {
  intervalSeconds: number;
  reps: number;
  reminderEnabled: boolean;
  reminderSeconds: number;
  countdownSeconds: number;
  audioLeadMs: number;
  markHeardLeadMs: number;
  loopCueMode: LoopCueMode;
};

export type CueKind = 'start' | 'countdown' | 'mark' | 'reminder';

export type CueEvent = {
  key: string;
  kind: CueKind;
  text: string;
  fireAt: number;
  expiresAt: number;
  vibrationMs: number;
  priority: number;
  repIndex: number;
};

export type CueSchedule = {
  runSequence: number;
  startedAt: number;
  totalEndAt: number;
  events: CueEvent[];
};

export type DueCueEvents = {
  due: CueEvent[];
  expired: CueEvent[];
};

type CreateCueScheduleOptions = {
  runSequence: number;
  settings: TimerSettings;
  startedAt: number;
};

const CUE_GRACE_MS: Record<CueKind, number> = {
  countdown: 900,
  mark: 900,
  reminder: 900,
  start: 1000,
};

const CUE_PRIORITY: Record<CueKind, number> = {
  start: 1,
  mark: 2,
  countdown: 3,
  reminder: 4,
};

export const SHORT_BEEP_PREROLL_MS = 180;

export function getInitialLeadMs(settings: TimerSettings) {
  if (settings.loopCueMode === 'mark') {
    return settings.audioLeadMs + settings.markHeardLeadMs;
  }

  return settings.audioLeadMs + settings.countdownSeconds * 1000;
}

export function getTotalMs(settings: TimerSettings) {
  return settings.intervalSeconds * 1000 * settings.reps;
}

function createCueEvent({
  fireAt,
  kind,
  repIndex,
  text,
  vibrationMs,
}: {
  fireAt: number;
  kind: CueKind;
  repIndex: number;
  text: string;
  vibrationMs: number;
}) {
  const extraKey =
    kind === 'countdown' ? `-${text}` : kind === 'reminder' ? `-${text.replace(/\D/g, '')}` : '';

  return {
    key: `${kind}-${repIndex}${extraKey}`,
    kind,
    text,
    fireAt,
    expiresAt: fireAt + CUE_GRACE_MS[kind],
    vibrationMs,
    priority: CUE_PRIORITY[kind],
    repIndex,
  };
}

export function createCueSchedule({
  runSequence,
  settings,
  startedAt,
}: CreateCueScheduleOptions): CueSchedule {
  const intervalMs = settings.intervalSeconds * 1000;
  const events: CueEvent[] = [];

  for (let repIndex = 0; repIndex < settings.reps; repIndex += 1) {
    const repStartAt = startedAt + repIndex * intervalMs;

    events.push(
      createCueEvent({
        fireAt: repStartAt - settings.audioLeadMs - SHORT_BEEP_PREROLL_MS,
        kind: 'start',
        repIndex,
        text: `Start rep ${repIndex + 1}`,
        vibrationMs: 130,
      })
    );

    if (settings.loopCueMode === 'mark') {
      events.push(
        createCueEvent({
          fireAt: repStartAt - settings.audioLeadMs - settings.markHeardLeadMs,
          kind: 'mark',
          repIndex,
          text: 'Take your marks',
          vibrationMs: 70,
        })
      );
    }

    if (settings.loopCueMode === 'countdown' && settings.countdownSeconds > 0) {
      for (let secondsLeft = settings.countdownSeconds; secondsLeft >= 1; secondsLeft -= 1) {
        events.push(
          createCueEvent({
            fireAt:
              repStartAt - secondsLeft * 1000 - settings.audioLeadMs - SHORT_BEEP_PREROLL_MS,
            kind: 'countdown',
            repIndex,
            text: String(secondsLeft),
            vibrationMs: 70,
          })
        );
      }
    }

    if (settings.reminderEnabled) {
      const nextRepStartAt = repStartAt + intervalMs;
      const countdownWindowStartMs = intervalMs - settings.countdownSeconds * 1000;
      const markWindowStartAt = nextRepStartAt - settings.markHeardLeadMs;
      const markWindowEndAt = nextRepStartAt;

      for (
        let reminderSecond = settings.reminderSeconds;
        reminderSecond < settings.intervalSeconds;
        reminderSecond += settings.reminderSeconds
      ) {
        const reminderTargetMs = reminderSecond * 1000;
        const reminderAudibleAt = repStartAt + reminderTargetMs;
        const hasNextRep = repIndex < settings.reps - 1;
        const overlapsCountdown =
          hasNextRep &&
          settings.loopCueMode === 'countdown' &&
          settings.countdownSeconds > 0 &&
          reminderTargetMs >= countdownWindowStartMs;
        const overlapsMarkPrep =
          hasNextRep &&
          settings.loopCueMode === 'mark' &&
          reminderAudibleAt >= markWindowStartAt &&
          reminderAudibleAt < markWindowEndAt;

        if (overlapsCountdown || overlapsMarkPrep) {
          continue;
        }

        events.push(
          createCueEvent({
            fireAt: reminderAudibleAt - settings.audioLeadMs - SHORT_BEEP_PREROLL_MS,
            kind: 'reminder',
            repIndex,
            text: `Rep ${repIndex + 1}: ${reminderSecond}s`,
            vibrationMs: 100,
          })
        );
      }
    }
  }

  events.sort((a, b) => a.fireAt - b.fireAt || a.priority - b.priority);

  return {
    events,
    runSequence,
    startedAt,
    totalEndAt: startedAt + getTotalMs(settings),
  };
}

export function getDueCueEvents(
  schedule: CueSchedule,
  now: number,
  isHandled: (event: CueEvent) => boolean
): DueCueEvents {
  const due: CueEvent[] = [];
  const expired: CueEvent[] = [];

  for (const event of schedule.events) {
    if (isHandled(event)) {
      continue;
    }

    if (now > event.expiresAt) {
      expired.push(event);
      continue;
    }

    if (now >= event.fireAt) {
      due.push(event);
    }
  }

  due.sort((a, b) => a.priority - b.priority || a.fireAt - b.fireAt);
  expired.sort((a, b) => a.fireAt - b.fireAt || a.priority - b.priority);

  return { due, expired };
}
