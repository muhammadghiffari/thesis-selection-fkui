/**
 * F10 — Single source of truth for the period rules FAQ content.
 *
 * These chunks are embedded at startup and stored in support_chunks table
 * for vector-similarity retrieval. Each chunk should be ≤ 512 tokens for
 * best embedding quality.
 *
 * NOTE: This file MUST NOT contain any thesis titles or student PII.
 * It describes process rules only.
 */
export interface RuleChunk {
  id: string;        // stable slug for idempotent upsert
  category: string;  // for display/filtering
  content: string;   // the embeddable text
}

export const RULE_CHUNKS: RuleChunk[] = [
  {
    id: 'timing-overview',
    category: 'timing',
    content: `The thesis title selection (called "war") opens at a specific scheduled time set by admin.
The exact opening time is shown on the lobby countdown page and is server-authoritative.
You cannot access the title grid before the scheduled opening time.
The selection closes at a separate closing time; you must complete all 3 title selections before it closes.`,
  },
  {
    id: 'exactly-3-titles',
    category: 'selection',
    content: `Every student must select EXACTLY 3 thesis titles, assigned priority 1, 2, and 3.
You cannot submit fewer than 3 or more than 3 titles.
Priority 1 is your first choice, priority 2 is your second, and priority 3 is your third.
If you have not selected all 3 titles by the time the selection closes, you will be marked as incomplete.`,
  },
  {
    id: 'lock-mechanism',
    category: 'selection',
    content: `When you tap a title card, it is instantly locked for 30 seconds for you only.
You must click "Claim Final" within 30 seconds or the lock expires and the title becomes available again.
You may only have one active lock at a time. Tapping a new title releases your current lock.
The lock timer is shown on the card; it is server-authoritative, not your device clock.`,
  },
  {
    id: 'undo-window',
    category: 'selection',
    content: `After you confirm (click "Claim Final") a title, you have a 15-second undo window.
Within those 15 seconds you may release the title back to available.
After 15 seconds, the title is permanently yours until a swap request is approved.`,
  },
  {
    id: 'magic-link',
    category: 'access',
    content: `Access to the title selection system is via a magic link sent to your @ui.ac.id email.
The link is single-use and bound to the device you first open it on.
If you open the link on a different device, access will be denied for security reasons.
If your link has expired or you lost it, contact your administrator to resend it.
The link is valid for a limited time after you first open it.`,
  },
  {
    id: 'magic-link-resend',
    category: 'access',
    content: `If you did not receive your magic link email, check your spam folder first.
Your administrator can resend the magic link from the delivery dashboard.
Once you have used your magic link to log in (claimed it), the link cannot be reused or resent.
You can request a resend via the support chat if you have not yet claimed your link.`,
  },
  {
    id: 'swap-request',
    category: 'swap',
    content: `If you wish to change a confirmed title, you can submit a swap request.
Swap requests require: a category (wrong pick / interest mismatch / lecturer-schedule issue / other)
and a written reason of at least 20 characters.
You can cancel a pending swap request any time before a decision is made.
You may only have 1 active swap request at a time.
There is a 5-minute cooldown between swap requests.
The lecturer or admin will review your request and provide a written decision note.`,
  },
  {
    id: 'swap-approval',
    category: 'swap',
    content: `When your swap request is approved, your title enters a 60-second pending-release window.
During those 60 seconds the title is still yours and you may reclaim it if you change your mind.
After 60 seconds, the title becomes available again and other students may claim it.
If the title is released, your attempts_left counter increases by 1 so you can try again.`,
  },
  {
    id: 'attempt-limits',
    category: 'selection',
    content: `Each student has a limited number of claim attempts per period (default: 4).
Each successful "Claim Final" counts as one attempt.
If your swap is approved and the title is released, you get one attempt back.
Contact your administrator if you believe your attempt count is incorrect.`,
  },
  {
    id: 'auto-war',
    category: 'selection',
    content: `The auto-war feature lets you pre-confirm your top AI-recommended title at the exact moment selection opens.
Enabling auto-war requires an open browser tab on the lobby page at the time of opening.
You must give explicit consent before enabling auto-war.
Auto-war uses your research interest preferences to find the best-matching available title.
You can disable auto-war at any time before selection opens.`,
  },
  {
    id: 'title-secrecy',
    category: 'selection',
    content: `Thesis titles are kept secret until the selection opens.
You cannot view any title information before the scheduled opening time.
The title grid is revealed to all students simultaneously at the scheduled opening.`,
  },
  {
    id: 'watchers',
    category: 'swap',
    content: `You can watch up to 10 titles that are in "swap requested" or "pending release" states.
If a watched title becomes available, you will receive an in-app notification and an email.
Only one notification is sent per availability transition per watcher.
Go to the title card and click "Watch" to subscribe. Click again to unsubscribe.`,
  },
  {
    id: 'integrity',
    category: 'integrity',
    content: `The system automatically detects unusual activity patterns such as:
- Accessing the system from multiple devices (device mismatch)
- Sharing the same IP address with too many other students
- Confirming a title suspiciously fast (under 2 seconds after locking)
- Attempting to access titles before the official opening time
These are flagged for human review by your lecturer or admin. 
Flags do NOT automatically block you — a human always makes the final decision.`,
  },
  {
    id: 'escalation',
    category: 'support',
    content: `If the self-service actions in this chat do not resolve your issue, you can:
1. Create an escalation ticket — your context (name, period, last error) is automatically attached.
2. Contact admin via WhatsApp using the deep-link provided in the chat.
Tickets are reviewed by admin during business hours. Please include as much detail as possible.`,
  },
];
