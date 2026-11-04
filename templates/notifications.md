# SplitSentinel — Notification templates

Sent by email (Gmail connector). Placeholders in `{braces}` are filled by the Flow.

## Released
**Subject:** PR {prId} approved for normal routing
**Body:**
Hi {requesterName},

Your purchase requisition {prId} ({description}, INR {amount}) passed the SplitSentinel check and continues through normal approval.

SplitSentinel case: {caseId}

## Held for review
**Subject:** PR {prId} held for review: possible split purchase
**Body:**
Hi {requesterName},

Your purchase requisition {prId} has been grouped with {relatedPrIds} (combined INR {combinedAmount}). Under the procurement policy, the combined value needs approval at tier {requiredTier} ({approverRole}). It has been sent to them for review.

Reason: {reasoning}

SplitSentinel case: {caseId}

## Justification requested
**Subject:** Action needed: explain PR {prId}
**Body:**
Hi {requesterName},

Your requisitions {relatedPrIds} (combined INR {combinedAmount}) look like one requirement. Please open the task in Action Center and either explain why they are separate requirements or confirm that you will consolidate them. If there's no response within 24 hours, the case goes to the approver without your explanation.

SplitSentinel case: {caseId}

## Consolidated
**Subject:** PRs {relatedPrIds} consolidated
**Body:**
Hi {requesterName},

{decidedBy} reviewed your requisitions and consolidated them into one requirement of INR {combinedAmount}. It will now go through tier {requiredTier} approval{rfqClause}.

Comment: {humanComment}

SplitSentinel case: {caseId}

## Rejected
**Subject:** PR {prId} rejected
**Body:**
Hi {requesterName},

{decidedBy} rejected requisition(s) {relatedPrIds}.

Comment: {humanComment}

SplitSentinel case: {caseId}

## Escalated
**Subject:** SplitSentinel case {caseId} escalated
**Body:**
The review of PR {prId} (combined INR {combinedAmount}) was not completed within 48 hours and has been escalated to {nextApproverRole}.

## Unverified hold
**Subject:** PR {prId} on hold: check could not be completed
**Body:**
SplitSentinel could not load the data needed to check PR {prId}, so it is on hold (status Unverified). Procurement operations has been notified and will re-run the check.

Error: {errorSummary}
