'use client';

import { Label, controlClass } from '@/components/ui';
import {
  buildCron,
  describeCron,
  untilNextRun,
  WEEKDAY_LABELS,
  type Frequency,
  type ScheduleParts,
} from '@/lib/cron';

/**
 * Picks a schedule without typing anything.
 *
 * This was a text box expecting "0 4 * * *": anyone who mistyped it got a
 * schedule that silently never fired, and anyone who did not know cron could
 * not schedule at all. Then it was selects plus a raw-expression escape hatch,
 * which left one text box for the one case most likely to be got wrong.
 *
 * Now every schedule the matcher understands can be built from controls, so
 * there is nothing to type. The expression is still shown — to read back and
 * check, not to compose.
 */

const FREQUENCIES: { value: Frequency; label: string }[] = [
  { value: 'every_15_min', label: 'Every 15 minutes' },
  { value: 'hourly', label: 'Every hour' },
  { value: 'daily', label: 'Every day' },
  { value: 'weekdays', label: 'Weekdays (Mon–Fri)' },
  { value: 'days', label: 'Chosen days…' },
];

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const MINUTES = [0, 5, 10, 15, 20, 30, 40, 45, 50];
const SHORT_DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export default function SchedulePicker({
  value,
  onChange,
}: {
  value: ScheduleParts;
  onChange: (next: ScheduleParts) => void;
}) {
  const expression = buildCron(value);
  const until = untilNextRun(expression);
  const set = (patch: Partial<ScheduleParts>) => onChange({ ...value, ...patch });

  const showTime = value.frequency === 'daily' || value.frequency === 'weekdays' || value.frequency === 'days';
  const showMinute = showTime || value.frequency === 'hourly';

  // A saved expression the controls cannot express is shown rather than
  // silently rewritten — losing somebody's schedule to make the UI tidy would
  // be worse than admitting the widgets do not cover it.
  if (value.frequency === 'custom') {
    return (
      <div className="space-y-2">
        <Label hint="set outside this picker">Schedule</Label>
        <p className="text-body text-[11px]">
          <span className="font-mono">{value.expression}</span>
          <span className="text-subtle ml-1.5">{describeCron(expression)}</span>
        </p>
        <button
          type="button"
          onClick={() => set({ frequency: 'daily' })}
          className="text-muted hover:text-foreground text-[11px] underline underline-offset-2"
        >
          Replace with a schedule I can edit
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <Label>Runs</Label>
          <select
            value={value.frequency}
            onChange={(e) => set({ frequency: e.target.value as Frequency })}
            className={`${controlClass} w-44`}
          >
            {FREQUENCIES.map((f) => (
              <option key={f.value} value={f.value}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        {value.frequency === 'days' ? (
          <div>
            <Label hint={value.weekdays.length === 0 ? 'pick at least one' : `${value.weekdays.length} selected`}>
              On
            </Label>
            <div className="mt-1 flex gap-1">
              {SHORT_DAYS.map((d, i) => {
                const on = value.weekdays.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    aria-label={WEEKDAY_LABELS[i]}
                    onClick={() =>
                      set({
                        weekdays: on ? value.weekdays.filter((x) => x !== i) : [...value.weekdays, i].sort((a, b) => a - b),
                      })
                    }
                    className={`h-7 w-8 rounded-md border text-[10px] font-bold transition-colors ${
                      on
                        ? 'border-brand bg-brand text-white'
                        : 'border-border-base text-muted hover:border-border-strong hover:text-foreground'
                    }`}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        {showTime ? (
          <label className="block">
            <Label hint="UTC">At</Label>
            <select
              value={value.hour}
              onChange={(e) => set({ hour: Number(e.target.value) })}
              className={`${controlClass} w-20`}
            >
              {HOURS.map((h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {showMinute ? (
          <label className="block">
            <Label>{showTime ? 'Minutes' : 'At minute'}</Label>
            <select
              value={value.minute}
              onChange={(e) => set({ minute: Number(e.target.value) })}
              className={`${controlClass} w-20`}
            >
              {MINUTES.map((m) => (
                <option key={m} value={m}>
                  {String(m).padStart(2, '0')}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>

      <p className="text-muted text-[11px]">
        {describeCron(expression)}
        <span className="text-subtle ml-1.5 font-mono">{expression}</span>
        {until ? <span className="text-subtle ml-1.5">· next {until}</span> : null}
      </p>
    </div>
  );
}
