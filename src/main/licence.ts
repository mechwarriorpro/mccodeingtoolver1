/**
 * The licence that is actually in force, and when to remind someone of it.
 *
 * This app is a **solo project**. It is free to use for solo developers and for
 * projects that do not make money; a commercial licence is required for anything
 * that does. That is a *licence term*, not a feature gate — there is deliberately
 * no code here that disables a feature, caps a model, or tries to work out whether
 * a company is using it. Detecting a company from a machine name or a username is
 * both unreliable and wrong, and gating features on it punishes the hobbyists the
 * licence exists to protect.
 *
 * What this module does is three small things, all of them honest:
 *
 *  1. States the terms in one place, so the app, the licence file and the README
 *     cannot drift apart.
 *  2. Counts launches and decides when a reminder is due — after enough real use
 *     that the person has decided they like the tool, never during work.
 *  3. Records a commercial licence when one has been bought, so a licensed user
 *     stops being reminded and has something to point at.
 *
 * The purity is deliberate: everything here is a pure function of the counter and
 * the clock, so it can be tested without Electron, without a network, and without
 * a licensed key.
 */

/** How the app is being used, as far as the licence is concerned. */
export type LicenceKind = 'solo' | 'commercial'

/**
 * The terms, as data.
 *
 * `why` is the sentence shown in the reminder: the whole point is that a stranger
 * who has used the app fifteen times is told what it costs, by whom, and why —
 * not shown a locked door.
 */
export const LICENCE_TERMS = {
  holder: 'ShadowClanGaming',
  /** Free of charge, no attribution required. */
  freeFor: [
    'Solo developers, however many hours you put in',
    'Any project that does not make money — mods published for free, packs with no revenue'
  ],
  /** Needs a commercial licence. */
  commercialFor: [
    'Selling a mod, pack, server or service that was built with this app',
    'Building for a client as paid work',
    'Using it inside a company, studio or team of any size, whether or not the output is sold'
  ],
  /**
   * What unlicensed commercial use costs.
   *
   * Stated in the app, not buried in the licence: a fee nobody knows about is a
   * fee that reads as a trap. `greaterOf` is the honest shape — a revenue royalty
   * for work with traceable income, and a calculable multiple of list price for
   * the far more common case where nobody can see the revenue.
   */
  unlicensed: {
    headline: 'Using it commercially without a licence costs 15% of what you made',
    detail:
      'The retroactive fee is 15% of revenue from that work, or double the licence fee for the period (at $50 that is $100 for a year) — whichever is greater — payable within 30 days of a written demand, plus recovery costs.',
    basis: 'LICENCE §5. Unlicensed use is never permitted; this is what it costs, not a way to buy permission afterwards.'
  },
  why: [
    'This is one person building in their spare time, not a studio. The tool is free because',
    'hobbyists keep it alive; commercial use is what pays for the hours it takes.'
  ].join(' '),
  /** Where the commercial licence is bought. */
  url: 'https://github.com/mechwarriorpro/mccodeingtoolver1#licence',

  /**
   * The commercial licence, stated as a price rather than a negotiation.
   *
   * A reminder that says "buy a licence" without saying how much loses exactly
   * the people who would have paid. Named in the licence file too, so the app and
   * the terms cannot drift apart.
   */
  commercial: {
    /** Base fee, in Australian dollars. */
    baseAud: 50,
    /** What one fee covers. */
    termMonths: 12,
    /** What unlicensed use costs, per §5.1(b): double, minimum one fee. */
    unlicensedMultiple: 2,
    currency: 'AUD',
    summary: 'AUD $50, once, for 12 months — one person or one business, unlimited projects.',
    /** What a year of unlicensed commercial use comes to at the base rate. */
    unlicensedYearAud: 100
  }
} as const

/**
 * Reminder policy.
 *
 * Fifteen launches, not fifteen days: a launch is a decision, and a fortnight of
 * real use is long enough that the person has formed an opinion. The counter
 * resets on dismissal, so the reminder is every fifteen launches rather than
 * every launch after the fifteenth — the nag that made WinRAR a joke.
 */
export const NAG = {
  /** Launches before the first reminder, and between later ones. */
  everyLaunches: 15,
  /** A reminder is never in a session that has any of these going on. */
  deferDuringWork: ['agent running', 'build running', 'download in flight']
} as const

/** What the config needs to remember. Three fields, no server. */
export interface LicenceState {
  /** Launches recorded so far, reset to 0 when a reminder is dismissed. */
  launchCount: number
  /** A commercial licence key, once one has been entered. Empty = unlicensed. */
  key: string
  /** Epoch ms of the last reminder, so it is never shown twice in a session. */
  lastNagAt: number
}

export const DEFAULT_LICENCE_STATE: LicenceState = { launchCount: 0, key: '', lastNagAt: 0 }

export interface LaunchResult {
  state: LicenceState
  /** True when this launch is the one that should show the reminder. */
  showReminder: boolean
}

/**
 * Count a launch and decide whether a reminder is due.
 *
 * Called once, at startup. `now` is injected so the behaviour is testable and so
 * a machine with a wrong clock cannot show the reminder more than once a session.
 */
export function recordLaunch(state: LicenceState | undefined, opts: { now?: number; sessionAlreadyNagged?: boolean; licensed?: boolean } = {}): LaunchResult {
  const now = opts.now ?? Date.now()
  // A config written by an older build has no `licence` field at all, and a
  // half-written one can have a null. Neither is worth a crash at startup.
  const base = state ?? DEFAULT_LICENCE_STATE
  const next: LicenceState = { ...base, launchCount: (Number(base.launchCount) || 0) + 1 }
  const licensed = opts.licensed ?? Boolean(base.key)
  // A licensed user is never reminded: they have already made the decision.
  if (licensed) return { state: next, showReminder: false }
  // Once per session, whatever the counter says.
  if (opts.sessionAlreadyNagged) return { state: next, showReminder: false }
  if (next.launchCount < NAG.everyLaunches) return { state: next, showReminder: false }
  return { state: { ...next, lastNagAt: now }, showReminder: true }
}

/**
 * Dismiss the reminder.
 *
 * Resets the counter rather than leaving it above the threshold: the next
 * reminder should come after another fifteen launches of real use, not on the
 * next start.
 */
export function dismissReminder(state: LicenceState | undefined): LicenceState {
  return { ...(state ?? DEFAULT_LICENCE_STATE), launchCount: 0 }
}

/**
 * The reminder's text, in the order a person reads it: what this is, who pays,
 * what is free, and what to do about it.
 */
export function reminderText(state: LicenceState | undefined): {
  title: string
  body: string[]
  free: string[]
  commercial: string[]
  unlicensed: { headline: string; detail: string; basis: string }
  action: string
} {
  const launches = (state ?? DEFAULT_LICENCE_STATE).launchCount
  return {
    title: 'MC Forge Agent is a solo project',
    body: [
      LICENCE_TERMS.why,
      `You have opened it ${launches} times, so this is probably worth a moment:`,
      `A commercial licence is ${LICENCE_TERMS.commercial.summary}`
    ],
    free: [...LICENCE_TERMS.freeFor],
    commercial: [...LICENCE_TERMS.commercialFor],
    unlicensed: { ...LICENCE_TERMS.unlicensed },
    action: 'Keep building — this is free unless you are making money from it.'
  }
}

/**
 * A commercial licence key, checked for shape only.
 *
 * Deliberately not a cryptographic check: there is no licence server, no
 * phone-home and no per-seat metering in this app, because a solo developer
 * working offline should never be locked out by a network. A key here is a
 * *record* — something to point at — and the terms are enforced by the licence,
 * not by the binary.
 */
export function normaliseKey(raw: string): string {
  return (raw ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '')
}

export function looksLikeCommercialKey(raw: string): boolean {
  const key = normaliseKey(raw)
  return /^MCFA[0-9A-Z]{12,}$/.test(key)
}

/** What the licence panel says about the current state. */
export function licenceSummary(state: LicenceState | undefined): { licensed: boolean; title: string; detail: string } {
  state = state ?? DEFAULT_LICENCE_STATE
  if (state.key && looksLikeCommercialKey(state.key)) {
    return {
      licensed: true,
      title: 'Commercial licence recorded',
      detail: `Key ${normaliseKey(state.key).slice(0, 8)}… is stored on this machine. Keep it with your records; it is what a commercial licence is verified against.`
    }
  }
  if (state.key) {
    return {
      licensed: false,
      title: 'That key does not look right',
      detail: 'Commercial keys are MCFA followed by at least twelve letters or digits. Check it, or ask for a replacement — nothing has been locked.'
    }
  }
  return {
    licensed: false,
    title: 'Free for solo and non-commercial use',
    detail: `${LICENCE_TERMS.why} Commercial use needs a licence: ${LICENCE_TERMS.commercial.summary} ${LICENCE_TERMS.url}`
  }
}

/**
 * Whether a reminder may be shown right now.
 *
 * The one hard rule of the whole feature: never in the middle of someone's work.
 * An agent run, a build or a download is a person mid-task, and interrupting it
 * to ask for money is how a tool gets a reputation.
 */
export function mayInterrupt(activity: { agentRunning?: boolean; buildRunning?: boolean; downloadRunning?: boolean }): boolean {
  return !(activity.agentRunning || activity.buildRunning || activity.downloadRunning)
}
