import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import {
  formatMultiplierX100,
  parseSourceLabelInput,
  validateRoundRecord,
  type RoundDto,
} from '@aviator/shared';
import { ApiRequestError, api } from '../../api/client';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FormField, inputClass } from '../../components/FormField';
import { Notice } from '../../components/Notice';
import { Panel } from '../../components/Panel';
import { formatTimestamp } from '../../lib/format';

const DEFAULT_SOURCE = 'manual entry';

interface FormState {
  source: string;
  multiplier: string;
  sourceRoundId: string;
  eventAt: string;
}

type FieldErrors = Partial<Record<keyof FormState, string>>;

const EMPTY: FormState = { source: DEFAULT_SOURCE, multiplier: '', sourceRoundId: '', eventAt: '' };

/** Client-side checks use the same shared rules the server applies; the server re-validates everything. */
function validate(form: FormState): FieldErrors {
  const errors: FieldErrors = {};
  const source = parseSourceLabelInput(form.source);
  if (!source.ok) errors.source = source.issue.message;
  const record = validateRoundRecord(
    { multiplier: form.multiplier, sourceRoundId: form.sourceRoundId, eventAt: form.eventAt },
    new Date(),
  );
  if (!record.ok) {
    for (const issue of record.issues) {
      if (
        issue.field === 'multiplier' ||
        issue.field === 'sourceRoundId' ||
        issue.field === 'eventAt'
      ) {
        errors[issue.field] = issue.message;
      }
    }
  }
  return errors;
}

export function ManualEntryPage() {
  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [possibleDuplicate, setPossibleDuplicate] = useState(false);
  const [saved, setSaved] = useState<RoundDto | null>(null);

  const update = (field: keyof FormState) => (value: string) => {
    setForm((f) => ({ ...f, [field]: value }));
    setPossibleDuplicate(false);
  };

  const submit = async (event: FormEvent, allowPossibleDuplicate = false) => {
    event.preventDefault();
    if (submitting) return;
    setSaved(null);
    setServerError(null);
    const clientErrors = validate(form);
    setErrors(clientErrors);
    if (Object.keys(clientErrors).length > 0) return;

    setSubmitting(true);
    try {
      const { round } = await api.createRound({
        source: form.source,
        multiplier: form.multiplier,
        ...(form.sourceRoundId.trim() ? { sourceRoundId: form.sourceRoundId } : {}),
        ...(form.eventAt.trim() ? { eventAt: form.eventAt } : {}),
        ...(allowPossibleDuplicate ? { allowPossibleDuplicate: true } : {}),
      });
      // Only clear the round-specific fields once the server has confirmed the save.
      setSaved(round);
      setPossibleDuplicate(false);
      setForm((f) => ({ ...EMPTY, source: f.source }));
    } catch (error) {
      if (error instanceof ApiRequestError && error.code === 'validation_error') {
        const fieldErrors: FieldErrors = {};
        for (const detail of error.fieldErrors) {
          if (detail.path in EMPTY) fieldErrors[detail.path as keyof FormState] = detail.message;
        }
        setErrors(fieldErrors);
        setServerError('The server rejected the input. Correct the highlighted fields.');
      } else if (error instanceof ApiRequestError && error.code === 'possible_duplicate') {
        setPossibleDuplicate(true);
      } else {
        setServerError(error instanceof Error ? error.message : 'The round could not be saved.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <Panel
        title="Add a round"
        subtitle="Record one historical round you observed or obtained from a permitted source"
      >
        <form
          noValidate
          onSubmit={(e) => void submit(e)}
          className="flex flex-col gap-4"
          aria-label="Add a round"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="round-multiplier"
              label="Multiplier"
              required
              hint="Crash multiplier, e.g. 2.35 (at most two decimals, at least 1.00)"
              error={errors.multiplier}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  inputMode="decimal"
                  autoComplete="off"
                  value={form.multiplier}
                  onChange={(e) => update('multiplier')(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              id="round-source"
              label="Source / provenance"
              required
              hint="Where this value came from. Keep it accurate; do not name a platform you did not get it from."
              error={errors.source}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  maxLength={100}
                  value={form.source}
                  onChange={(e) => update('source')(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              id="round-source-id"
              label="Source round ID"
              hint="Only if the source shows one. Never invent an ID."
              error={errors.sourceRoundId}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  maxLength={128}
                  autoComplete="off"
                  value={form.sourceRoundId}
                  onChange={(e) => update('sourceRoundId')(e.target.value)}
                />
              )}
            </FormField>
            <FormField
              id="round-event-at"
              label="Event time"
              hint="ISO-8601 with a time zone, e.g. 2026-01-31T14:05:09Z or 2026-01-31T15:05:09+01:00"
              error={errors.eventAt}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  autoComplete="off"
                  placeholder="2026-01-31T14:05:09Z"
                  value={form.eventAt}
                  onChange={(e) => update('eventAt')(e.target.value)}
                />
              )}
            </FormField>
          </div>

          {serverError ? <ErrorNotice message={serverError} /> : null}
          {possibleDuplicate ? (
            <Notice tone="warning">
              <p>
                A stored round already has this source, event time and multiplier. Without a source
                round ID it cannot be confirmed whether this is the same round.
              </p>
              <button
                type="button"
                disabled={submitting}
                onClick={(e) => void submit(e, true)}
                className="mt-2 rounded-md px-3 py-1.5 text-sm ring-1 ring-amber-400/50 hover:bg-amber-400/10 disabled:opacity-50"
              >
                Save anyway as a separate round
              </button>
            </Notice>
          ) : null}
          {saved ? (
            <Notice tone="success">
              Saved round #{saved.id}: {formatMultiplierX100(saved.multiplierX100)} from “
              {saved.source}”{saved.eventAt ? ` at ${formatTimestamp(saved.eventAt)}` : ''}.{' '}
              <Link to="/rounds" className="underline">
                View in round list
              </Link>
            </Notice>
          ) : null}

          <div>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-500 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {submitting ? 'Saving…' : 'Save round'}
            </button>
          </div>
        </form>
      </Panel>
      <Panel title="Rules">
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-400">
          <li>Values are stored exactly; nothing is rounded or corrected.</li>
          <li>
            A round with the same source and source round ID is never stored twice or overwritten.
          </li>
          <li>Times without a time zone are rejected rather than guessed.</li>
          <li>Entering rounds does not place bets and connects to no betting account.</li>
        </ul>
      </Panel>
    </div>
  );
}
