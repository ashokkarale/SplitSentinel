import { useState, useEffect } from 'react';
import type { ChangeEvent } from 'react';
import { Theme } from '@uipath/coded-action-app';
import { codedActionAppService } from '../uipath';
import './Form.css';
import './SplitReview.css';

interface RelatedPr {
  prId: string;
  date: string;
  vendor: string;
  description: string;
  amount: number;
  isAnchor: boolean;
}

interface Signal {
  text: string;
  points: number;
}

// One property per field across all schema sections (inputs + outputs; inOuts is empty).
interface FormData {
  // inputs — read-only
  prId: string;
  caseRef: string;
  requesterName: string;
  requesterCostCenter: string;
  whatHappened: string;
  combinedAmount: number;
  approvalTier: string;
  approverRole: string;
  rfqRequired: boolean;
  anchorTier: string;
  anchorApproverRole: string;
  riskScore: number;
  relatedPrs: RelatedPr[];
  signals: Signal[];
  aiVerdict: string;
  aiConfidence: number;
  aiException: string;
  aiReasoning: string;
  aiCorrections: string;
  requesterJustification: string;
  // outputs — reviewer-filled
  comment: string;
}

const defaultFormData: FormData = {
  prId: '',
  caseRef: '',
  requesterName: '',
  requesterCostCenter: '',
  whatHappened: '',
  combinedAmount: 0,
  approvalTier: '',
  approverRole: '',
  rfqRequired: false,
  anchorTier: '',
  anchorApproverRole: '',
  riskScore: 0,
  relatedPrs: [],
  signals: [],
  aiVerdict: '',
  aiConfidence: 0,
  aiException: '',
  aiReasoning: '',
  aiCorrections: '',
  requesterJustification: '',
  comment: '',
};

const isDarkTheme = (theme: Theme): boolean =>
  theme === Theme.Dark || theme === Theme.DarkHighContrast;

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

const VERDICTS: Record<string, { label: string; tone: string }> = {
  SPLIT: { label: 'Split', tone: 'danger' },
  LIKELY_SPLIT: { label: 'Likely split', tone: 'warning' },
  NOT_SPLIT: { label: 'Not a split', tone: 'success' },
  FAILED: { label: 'No usable AI answer', tone: 'neutral' },
};

const riskBand = (score: number) => (score >= 60 ? 'high' : score >= 30 ? 'medium' : 'low');

interface FormProps {
  onInitTheme: (isDark: boolean) => void;
  darkTheme: boolean;
  onToggleTheme: () => void;
}

function Form({ onInitTheme, darkTheme, onToggleTheme }: FormProps) {
  const [formData, setFormData] = useState<FormData>(defaultFormData);
  const [isReadOnly, setIsReadOnly] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    codedActionAppService.getTask().then((task) => {
      // Merge over defaults — task.data has inputs + inOuts only, never outputs on first load.
      const merged = task.data
        ? { ...defaultFormData, ...(task.data as Partial<FormData>) }
        : defaultFormData;
      setFormData(merged);
      setIsReadOnly(task.isReadOnly);
      onInitTheme(isDarkTheme(task.theme));
    });
  }, [onInitTheme]);

  const handleTextChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    if (isReadOnly) return;
    const { name, value } = e.target;
    const updated = { ...formData, [name]: value };
    setFormData(updated);
    codedActionAppService.setTaskData(updated);
  };

  // Required output filled, and not read-only.
  const isFormValid = !isReadOnly && !submitting && formData.comment.trim() !== '';

  const complete = async (outcome: string) => {
    setSubmitting(true);
    try {
      await codedActionAppService.completeTask(outcome, formData);
    } finally {
      setSubmitting(false);
    }
  };

  const prs = [...(formData.relatedPrs || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const prTotal = prs.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const signals = formData.signals || [];
  const verdict = VERDICTS[formData.aiVerdict] || { label: 'Not assessed', tone: 'neutral' };
  const band = riskBand(formData.riskScore);
  const approver = formData.approverRole || 'the approver';
  const others = prs.filter((p) => !p.isAnchor).map((p) => p.prId);

  // Every button explains exactly what will happen — shown as a hover / focus tooltip.
  const outcomes = [
    {
      key: 'NotASplit', label: 'Not a split', kind: 'secondary',
      tip: 'Release the PRs as raised and record this as a false alarm. Helps tune the rules.',
    },
    {
      key: 'KeepSeparate', label: 'Keep separate', kind: 'secondary',
      tip: 'They really are separate needs: release each PR at its own approval level.',
    },
    {
      key: 'Reject', label: 'Reject', kind: 'secondary',
      tip: `Reject ${prs.length > 1 ? 'all ' + prs.length + ' PRs' : 'the PR'}. The requester is emailed your comment.`,
    },
    {
      key: 'MergePRs', label: 'Merge PRs', kind: 'primary',
      tip: `Merge into one ${inr(formData.combinedAmount || prTotal)} requirement and send it for ${approver} approval`
        + (formData.rfqRequired ? ' with a competitive bid (RFQ).' : '.'),
    },
  ];

  return (
    <div className="review-app review-app--wide">
      <header className="review-header">
        <div className="review-header__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 3l8 4v5c0 5-3.5 8-8 9-4.5-1-8-4-8-9V7z" />
            <path d="M9 12l2 2 4-4" />
          </svg>
        </div>
        <div className="review-header__titles">
          <h1 className="review-header__title">Possible split purchase · {formData.prId}</h1>
          <p className="review-header__subtitle">
            {formData.requesterName}{formData.requesterCostCenter ? ` (${formData.requesterCostCenter})` : ''}
            {formData.caseRef ? ` · ${formData.caseRef}` : ''}
          </p>
        </div>
        <div className="review-header__actions">
          {isReadOnly && <span className="review-badge">Read only</span>}
          <button
            type="button"
            className="theme-toggle"
            onClick={onToggleTheme}
            aria-label={darkTheme ? 'Switch to light mode' : 'Switch to dark mode'}
            title={darkTheme ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {darkTheme ? (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="4" />
                <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>
        </div>
      </header>

      <div className="form-container form-container--enter">
        {/* Summary */}
        <section className="form-section">
          <p className="sr-summary">{formData.whatHappened}</p>
          <div className="sr-tiles">
            <div className="sr-tile">
              <span className="sr-tile__label">Combined amount</span>
              <span className="sr-tile__value">{inr(formData.combinedAmount || prTotal)}</span>
              <span className="sr-tile__hint">{prs.length} purchase requisition{prs.length === 1 ? '' : 's'}</span>
            </div>
            <div className="sr-tile">
              <span className="sr-tile__label">Approval needed</span>
              <span className="sr-tile__value">{formData.approvalTier} · {approver}</span>
              <span className="sr-tile__hint">
                {formData.rfqRequired ? 'Competitive bid (RFQ) required' : 'No RFQ required'}
                {formData.anchorTier && formData.anchorTier !== formData.approvalTier
                  ? ` · alone: ${formData.anchorTier}${formData.anchorApproverRole ? ' (' + formData.anchorApproverRole + ')' : ''}`
                  : ''}
              </span>
            </div>
            <div className={`sr-tile sr-tile--${band}`}>
              <span className="sr-tile__label">Risk score</span>
              <span className="sr-tile__value">{formData.riskScore} / 100</span>
              <span className="sr-tile__hint">{band} risk</span>
            </div>
          </div>
        </section>

        {/* Purchase requisitions */}
        <section className="form-section">
          <h2 className="form-title">Purchase requisitions</h2>
          <div className="sr-table-wrap">
            <table className="sr-table">
              <thead>
                <tr>
                  <th>PR</th>
                  <th>Date</th>
                  <th>Vendor</th>
                  <th>Item</th>
                  <th className="num">Amount</th>
                </tr>
              </thead>
              <tbody>
                {prs.map((p) => (
                  <tr key={p.prId} className={p.isAnchor ? 'is-anchor' : ''}>
                    <td className="mono">
                      {p.prId}
                      {p.isAnchor && <span className="sr-pill">this PR</span>}
                    </td>
                    <td className="nowrap">{p.date}</td>
                    <td>{p.vendor}</td>
                    <td className="wrap">{p.description}</td>
                    <td className="num">{inr(p.amount)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total{others.length ? ` (${formData.prId} + ${others.join(', ')})` : ''}</td>
                  <td className="num">{inr(prTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* Rule signals */}
        <section className="form-section">
          <h2 className="form-title">Why it was flagged</h2>
          <div className="sr-table-wrap">
            <table className="sr-table">
              <thead>
                <tr>
                  <th>Signal</th>
                  <th className="num">Points</th>
                </tr>
              </thead>
              <tbody>
                {signals.map((s, i) => (
                  <tr key={i}>
                    <td className="wrap">{s.text}</td>
                    <td className={`num ${s.points < 0 ? 'neg' : 'pos'}`}>{s.points > 0 ? '+' : ''}{s.points}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td>Risk score (capped 0–100)</td>
                  <td className="num">{formData.riskScore}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        {/* AI assessment */}
        <section className="form-section">
          <h2 className="form-title">AI assessment</h2>
          <div className="sr-ai">
            <div className="sr-ai__head">
              <span className={`sr-verdict sr-verdict--${verdict.tone}`}>{verdict.label}</span>
              {formData.aiVerdict && formData.aiVerdict !== 'FAILED' && (
                <span className="sr-ai__conf">{Math.round((formData.aiConfidence || 0) * 100)}% confident</span>
              )}
              {formData.aiException && formData.aiException !== 'NONE' && (
                <span className="sr-ai__conf">Exception: {formData.aiException.replace(/_/g, ' ').toLowerCase()}</span>
              )}
            </div>
            <p className="sr-ai__text">{formData.aiReasoning}</p>
            {formData.aiCorrections && (
              <p className="sr-ai__note">Checked against the data and corrected: {formData.aiCorrections}</p>
            )}
          </div>
        </section>

        {formData.requesterJustification && (
          <section className="form-section">
            <h2 className="form-title">Requester's explanation</h2>
            <p className="sr-ai__text">{formData.requesterJustification}</p>
          </section>
        )}

        {/* Decision */}
        <section className="form-section">
          <h2 className="form-title">Your decision</h2>
          <div className="form-group">
            <label htmlFor="comment">
              Comment <span className="req" aria-hidden="true">*</span>
              <span className="sr-label-hint">Goes into the audit record and the email to the requester.</span>
            </label>
            <textarea
              id="comment"
              name="comment"
              rows={3}
              placeholder="Why did you choose this outcome?"
              value={formData.comment}
              onChange={handleTextChange}
              readOnly={isReadOnly}
            />
          </div>
        </section>
      </div>

      <div className="form-buttons">
        {outcomes.map((o) => (
          <span className="sr-tip" key={o.key}>
            <button
              type="button"
              className={`outcome-btn outcome-btn--${o.kind}`}
              onClick={() => complete(o.key)}
              disabled={!isFormValid}
              aria-describedby={`tip-${o.key}`}
            >
              {o.label}
            </button>
            <span role="tooltip" id={`tip-${o.key}`} className="sr-tip__bubble">
              {o.tip}
              {!isFormValid && !isReadOnly && <em> Add a comment to enable.</em>}
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default Form;
