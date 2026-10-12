import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { LEG_KEYS, type BacktestDatasetReport, type LegKey } from '@aviator/shared';
import { api, ApiRequestError } from '../api/client';
import { useApi } from '../api/useApi';
import { ErrorNotice } from '../components/ErrorNotice';
import { FormField, inputClass } from '../components/FormField';
import { Notice } from '../components/Notice';
import { PageHeader } from '../components/PageHeader';
import { Panel } from '../components/Panel';
import { formatCount } from '../lib/format';
import { AssumptionsList, BACKTEST_CAUTION, DatasetReportView } from './simulations/display';
import {
  buildRequest,
  datasetInput,
  initialDraft,
  mapServerErrors,
  type FieldErrors,
  type LegDraft,
  type StrategyDraft,
} from './simulations/strategyForm';

type DatasetCheck =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'done'; report: BacktestDatasetReport }
  | { status: 'error'; message: string };

const buttonClass =
  'rounded-md px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50';

export function StrategyLabPage() {
  const navigate = useNavigate();
  const sources = useApi((signal) => api.roundSources(signal));
  const [draft, setDraft] = useState<StrategyDraft>(initialDraft);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [check, setCheck] = useState<DatasetCheck>({ status: 'idle' });
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const update = (patch: Partial<StrategyDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    // A changed dataset invalidates the last check.
    if (['source', 'importId', 'eventFrom', 'eventTo'].some((k) => k in patch)) {
      setCheck({ status: 'idle' });
    }
  };
  const updateLeg = (key: LegKey, patch: Partial<LegDraft>) =>
    setDraft((d) => ({ ...d, legs: { ...d.legs, [key]: { ...d.legs[key], ...patch } } }));
  const text = (k: keyof StrategyDraft) => ({
    value: draft[k] as string,
    onChange: (e: { target: { value: string } }) => update({ [k]: e.target.value }),
  });

  const checkDataset = async () => {
    const datasetErrors: FieldErrors = {};
    const dataset = datasetInput(draft, datasetErrors);
    setErrors((e) => {
      const next = { ...e, ...datasetErrors };
      if (!datasetErrors.source) delete next.source;
      if (!datasetErrors.importId) delete next.importId;
      return next;
    });
    if (Object.keys(datasetErrors).length > 0) return;
    setCheck({ status: 'checking' });
    try {
      setCheck({ status: 'done', report: await api.simulationDataset(dataset) });
    } catch (error) {
      if (error instanceof ApiRequestError && error.fieldErrors.length > 0) {
        setErrors((e) => ({ ...e, ...mapServerErrors(error.fieldErrors) }));
      }
      setCheck({
        status: 'error',
        message: error instanceof Error ? error.message : 'The dataset check failed',
      });
    }
  };

  const run = async (event: FormEvent) => {
    event.preventDefault();
    setRunError(null);
    const built = buildRequest(draft);
    if (built.errors) {
      setErrors(built.errors);
      setRunError('Fix the highlighted fields before running.');
      return;
    }
    setErrors({});
    setRunning(true);
    try {
      const result = await api.runBacktest(built.request);
      void navigate(`/simulations/${result.id}`);
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setErrors(mapServerErrors(error.fieldErrors));
        setRunError(error.message);
      } else {
        setRunError('The backtest could not be run.');
      }
      setRunning(false);
    }
  };

  const sourceOptions = sources.status === 'success' ? sources.data.items : [];
  const err = (id: keyof FieldErrors) => errors[id];

  return (
    <>
      <PageHeader
        title="Strategy lab"
        description="Configure two virtual legs and a virtual bankroll, choose historical rounds, review the assumptions, and run a reproducible backtest."
      />

      <div
        role="note"
        className="mb-6 rounded-md border border-amber-400/30 bg-amber-400/5 px-4 py-3 text-sm text-amber-200"
      >
        {BACKTEST_CAUTION} The starting values (2.00x and 6.00x) are editable placeholders, not
        recommended stakes or targets.
      </div>

      <form onSubmit={run} aria-label="Backtest configuration" noValidate className="space-y-6">
        <div className="grid gap-6 md:grid-cols-2">
          {LEG_KEYS.map((key) => (
            <Panel key={key} title={`Leg ${key}`} subtitle="Virtual stake per round">
              <div className="space-y-4">
                <label className="flex items-center gap-2 text-sm text-slate-300">
                  <input
                    type="checkbox"
                    checked={draft.legs[key].enabled}
                    onChange={(e) => updateLeg(key, { enabled: e.target.checked })}
                  />
                  Enabled
                </label>
                <FormField
                  id={`leg${key}-label`}
                  label="Label"
                  required
                  error={err(`leg${key}-label`)}
                >
                  {(p) => (
                    <input
                      {...p}
                      className={inputClass}
                      maxLength={40}
                      value={draft.legs[key].label}
                      onChange={(e) => updateLeg(key, { label: e.target.value })}
                    />
                  )}
                </FormField>
                <div className="grid gap-4 sm:grid-cols-2">
                  <FormField
                    id={`leg${key}-stake`}
                    label={`Stake (${draft.currency})`}
                    hint="Major units, e.g. 500 or 500.50"
                    required
                    error={err(`leg${key}-stake`)}
                  >
                    {(p) => (
                      <input
                        {...p}
                        className={inputClass}
                        inputMode="decimal"
                        value={draft.legs[key].stake}
                        onChange={(e) => updateLeg(key, { stake: e.target.value })}
                      />
                    )}
                  </FormField>
                  <FormField
                    id={`leg${key}-target`}
                    label="Cashout target"
                    hint="At least 1.01, e.g. 2.00"
                    required
                    error={err(`leg${key}-target`)}
                  >
                    {(p) => (
                      <input
                        {...p}
                        className={inputClass}
                        inputMode="decimal"
                        value={draft.legs[key].target}
                        onChange={(e) => updateLeg(key, { target: e.target.value })}
                      />
                    )}
                  </FormField>
                </div>
              </div>
            </Panel>
          ))}
        </div>
        {errors.legs ? <ErrorNotice message={errors.legs} /> : null}

        <Panel
          title="Bankroll and risk"
          subtitle="Virtual funds; stops are checked after each round"
        >
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <FormField
              id="bankroll"
              label={`Starting bankroll (${draft.currency})`}
              required
              error={err('bankroll')}
            >
              {(p) => (
                <input {...p} className={inputClass} inputMode="decimal" {...text('bankroll')} />
              )}
            </FormField>
            <FormField
              id="policy"
              label="If the bankroll cannot cover a stake"
              required
              error={err('policy')}
            >
              {(p) => (
                <select
                  {...p}
                  className={inputClass}
                  value={draft.policy}
                  onChange={(e) =>
                    update({ policy: e.target.value === 'stop_run' ? 'stop_run' : 'skip_leg' })
                  }
                >
                  <option value="skip_leg">Skip that leg for the round</option>
                  <option value="stop_run">Stop the run</option>
                </select>
              )}
            </FormField>
            <FormField
              id="maxRounds"
              label="Maximum rounds"
              hint="Stop after this many rounds"
              error={err('maxRounds')}
            >
              {(p) => (
                <input {...p} className={inputClass} inputMode="numeric" {...text('maxRounds')} />
              )}
            </FormField>
            <FormField id="stopBelow" label="Stop if bankroll falls below" error={err('stopBelow')}>
              {(p) => (
                <input {...p} className={inputClass} inputMode="decimal" {...text('stopBelow')} />
              )}
            </FormField>
            <FormField
              id="stopAtOrAbove"
              label="Stop once bankroll reaches"
              error={err('stopAtOrAbove')}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  inputMode="decimal"
                  {...text('stopAtOrAbove')}
                />
              )}
            </FormField>
            <FormField
              id="maxDrawdownPercent"
              label="Stop at drawdown from peak (%)"
              hint="e.g. 50 for 50%"
              error={err('maxDrawdownPercent')}
            >
              {(p) => (
                <input
                  {...p}
                  className={inputClass}
                  inputMode="decimal"
                  {...text('maxDrawdownPercent')}
                />
              )}
            </FormField>
          </div>
        </Panel>

        <Panel title="Dataset" subtitle="Which stored rounds to replay">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              id="source"
              label="Source"
              hint="One source per backtest; rounds from different sources cannot be interleaved"
              required
              error={err('source')}
            >
              {(p) => (
                <select {...p} className={inputClass} {...text('source')}>
                  <option value="">Choose a source…</option>
                  {sourceOptions.map((s) => (
                    <option key={s.source} value={s.source}>
                      {s.source} ({formatCount(s.rounds)})
                    </option>
                  ))}
                </select>
              )}
            </FormField>
            <FormField
              id="importId"
              label="Import number"
              hint="Only rounds from this import"
              error={err('importId')}
            >
              {(p) => (
                <input {...p} className={inputClass} inputMode="numeric" {...text('importId')} />
              )}
            </FormField>
            <FormField
              id="eventFrom"
              label="Event time from"
              hint="Inclusive; ISO-8601 with time zone, e.g. 2026-01-01T00:00:00Z"
              error={err('eventFrom')}
            >
              {(p) => (
                <input {...p} className={inputClass} autoComplete="off" {...text('eventFrom')} />
              )}
            </FormField>
            <FormField
              id="eventTo"
              label="Event time to"
              hint="Exclusive; ISO-8601 with time zone"
              error={err('eventTo')}
            >
              {(p) => (
                <input {...p} className={inputClass} autoComplete="off" {...text('eventTo')} />
              )}
            </FormField>
          </div>
          {sources.status === 'success' && sourceOptions.length === 0 ? (
            <div className="mt-4">
              <Notice tone="info">
                No rounds are stored yet. Add or import historical rounds before running a backtest.
              </Notice>
            </div>
          ) : null}
          {sources.status === 'error' ? (
            <div className="mt-4">
              <ErrorNotice message={sources.message} />
            </div>
          ) : null}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => void checkDataset()}
              disabled={check.status === 'checking'}
              className={`${buttonClass} text-slate-200 ring-1 ring-slate-700 hover:bg-slate-800`}
            >
              {check.status === 'checking' ? 'Checking…' : 'Check dataset'}
            </button>
          </div>
          <div className="mt-4" aria-live="polite">
            {check.status === 'error' ? <ErrorNotice message={check.message} /> : null}
            {check.status === 'done' ? (
              <div className="space-y-4">
                {check.report.orderable ? (
                  <Notice tone="success">
                    {formatCount(check.report.roundsEligible)} round(s) can be replayed in order.
                  </Notice>
                ) : (
                  <ErrorNotice message={`Cannot be replayed: ${check.report.problem ?? ''}`} />
                )}
                <DatasetReportView report={check.report} />
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="Assumptions" subtitle="Review before running">
          <AssumptionsList />
          <label className="mt-4 flex items-start gap-2 text-sm text-slate-300">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
            />
            I understand this replays recorded rounds with virtual money and does not predict future
            rounds.
          </label>
        </Panel>

        <div className="space-y-3" aria-live="polite">
          {runError ? <ErrorNotice message={runError} /> : null}
          <button
            type="submit"
            disabled={running || !acknowledged}
            className={`${buttonClass} bg-sky-600 text-white hover:bg-sky-500`}
          >
            {running ? 'Running backtest…' : 'Run backtest'}
          </button>
          {!acknowledged ? (
            <p className="text-xs text-slate-500">
              Confirm the assumptions above to enable running.
            </p>
          ) : null}
        </div>
      </form>
    </>
  );
}
