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

// One property per field across all schema sections (inputs + outputs; inOuts is empty).
interface FormData {
  // inputs — read-only
  prId: string;
  caseRef: string;
  requesterName: string;
  message: string;
  combinedAmount: number;
  approvalTier: string;
  approverRole: string;
  rfqRequired: boolean;
  relatedPrs: RelatedPr[];
  // outputs — requester-filled
  justification: string;
  taskId: string;
}

const defaultFormData: FormData = {
  prId: '',
  caseRef: '',
  requesterName: '',
  message: '',
  combinedAmount: 0,
  approvalTier: '',
  approverRole: '',
  rfqRequired: false,
  relatedPrs: [],
  justification: '',
  taskId: '',
};

// An explanation has to say something specific to be worth re-checking.
const MIN_EXPLANATION = 20;

const isDarkTheme = (theme: Theme): boolean =>
  theme === Theme.Dark || theme === Theme.DarkHighContrast;

const inr = (n: number) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(n || 0);

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
      // The task id goes back as an output: the case records it as who decided.
      setFormData({ ...merged, taskId: String(task.taskId ?? '') });
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
  const approver = formData.approverRole || 'the approver';
  const explanationOk = formData.justification.trim().length >= MIN_EXPLANATION;
  const canAct = !isReadOnly && !submitting;

  const outcomes = [
    {
      key: 'MergeMyPRs', label: 'Merge my PRs', kind: 'secondary', enabled: canAct,
      tip: `They are one purchase: combine them into one ${inr(formData.combinedAmount || prTotal)} requirement `
        + `and send it for ${approver} approval. No explanation needed.`,
    },
    {
      key: 'SubmitExplanation', label: 'Submit explanation', kind: 'primary', enabled: canAct && explanationOk,
      tip: 'They are separate needs. The AI re-checks with your explanation, and an approver may still review it.'
        + (explanationOk ? '' : ` Write at least ${MIN_EXPLANATION} characters to enable.`),
    },
  ];

  return (
    <div className="review-app review-app--wide">
      <header className="review-header">
        <div className="review-header__icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3" />
            <path d="M12 17h.01" />
          </svg>
        </div>
        <div className="review-header__titles">
          <h1 className="review-header__title">Please explain {formData.prId}</h1>
          <p className="review-header__subtitle">
            Possible split purchase{formData.caseRef ? ` · ${formData.caseRef}` : ''}
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
        <section className="form-section">
          <p className="sr-summary">{formData.message}</p>
          <div className="sr-tiles">
            <div className="sr-tile">
              <span className="sr-tile__label">Together they come to</span>
              <span className="sr-tile__value">{inr(formData.combinedAmount || prTotal)}</span>
              <span className="sr-tile__hint">{prs.length} purchase requisition{prs.length === 1 ? '' : 's'}</span>
            </div>
            <div className="sr-tile">
              <span className="sr-tile__label">Approval that amount needs</span>
              <span className="sr-tile__value">{formData.approvalTier} · {approver}</span>
              <span className="sr-tile__hint">{formData.rfqRequired ? 'Competitive bid (RFQ) required' : 'No RFQ required'}</span>
            </div>
          </div>
        </section>

        <section className="form-section">
          <h2 className="form-title">Your purchase requisitions</h2>
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
                      {p.isAnchor && <span className="sr-pill">latest</span>}
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
                  <td colSpan={4}>Total</td>
                  <td className="num">{inr(prTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </section>

        <section className="form-section">
          <h2 className="form-title">Your explanation</h2>
          <div className="form-group">
            <label htmlFor="justification">
              Why are these separate needs?
              <span className="sr-label-hint">
                Be specific: different project, site, purpose or budget owner. General reasons such as "urgent" don't count.
              </span>
            </label>
            <textarea
              id="justification"
              name="justification"
              rows={4}
              placeholder="e.g. PR-2101 is for the IT floor refit (project ITF-26); PR-2104 replaces broken chairs in the support bay…"
              value={formData.justification}
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
              disabled={!o.enabled}
              aria-describedby={`tip-${o.key}`}
            >
              {o.label}
            </button>
            <span role="tooltip" id={`tip-${o.key}`} className="sr-tip__bubble">{o.tip}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export default Form;
