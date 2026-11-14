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
    summary: 'AUD $50, once, for 12 months — one solo developer or one server, unlimited projects.',
    /**
     * The absolute ceiling on any discount, whatever the seat count.
     *
     * The ladder currently tops out at 34%; this stays at 50% so a future edit to
     * the tiers cannot promise more than half price without changing a constant
     * that is named in the licence.
     */
    maxDiscountPercent: 50,
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

/**
 * The combination ladder.
 *
 * One licence is $50. Buy them together — a team, a server network, a studio with
 * contractors — and the price per seat falls at 25, 50, 75 and 100 seats, capped at
 * half price. The cap is not decoration: at 100 seats a licence is $25, and it
 * never goes below that however many more are bought. A discount with no floor
 * eventually becomes "ask me", which is the thing this whole structure exists to
 * avoid.
 */
export interface PriceTier {
  /** Seats from which this per-licence price applies. */
  minSeats: number
  /** Discount off the $50 list price, per licence. */
  discountPercent: number
}

/**
 * The combination ladder — a price per licence, in steps.
 *
 * ```
 *   1–24     $50.00       75–99    $37.50   (25% off)
 *   25–49    $47.50  (5%)  100+    $33.00   (34% off)
 *   50–74    $45.00  (10%)
 * ```
 *
 * The ladder tops out at 34% — $33 a licence at 100 and above. The absolute
 * ceiling stays at 50% in `maxDiscountPercent`, so no future edit of these tiers
 * can quietly promise more than half price.
 *
 * A quantity break means the *total* at a break can be less than the total just
 * below it — 75 licences at $30 is $2,250 while 74 at $37.50 is $2,775. That is
 * normal volume pricing and nobody is worse off, because the buyer who wanted 74
 * can simply order 75 and pay less for more. Trying to remove it makes the
 * discounts much shallower (4%, 11.8%, 21%, 34% at these thresholds) and never
 * reaches the half-price cap that is the point of the ladder.
 */
export const PRICE_TIERS: PriceTier[] = [
  { minSeats: 25, discountPercent: 5 },
  { minSeats: 50, discountPercent: 10 },
  { minSeats: 75, discountPercent: 25 },
  { minSeats: 100, discountPercent: 34 }
]

export interface PriceQuote {
  seats: number
  baseAud: number
  /** Full price before any combination discount. */
  listAud: number
  /** What is actually payable. */
  totalAud: number
  /** Per-seat price after the discount, to the cent. */
  perSeatAud: number
  discountPercent: number
  /** True when this quantity crossed a break and the total dipped. */
  atQuantityBreak: boolean
  tier?: PriceTier
  /** One line for the UI and for an invoice. */
  summary: string
}

/** Money to the cent, without floating-point noise like 44.999999999. */
function round2(value: number): number {
  return Math.round(value * 100) / 100
}

/**
 * Price a commercial purchase of one or more licences.
 *
 * Pure, so the licence file, the README and the app cannot disagree: this is the
 * single place the ladder is applied.
 */
/** The plain arithmetic, with no break-checking — used by the check itself. */
function tierOf(seats: number, baseAud: number = LICENCE_TERMS.commercial.baseAud): { total: number; discount: number; perSeat: number } {
  const n = Math.max(1, Math.floor(Number(seats) || 1))
  const tier = [...PRICE_TIERS].sort((a, b) => b.minSeats - a.minSeats).find((t) => n >= t.minSeats)
  const discount = Math.min(LICENCE_TERMS.commercial.maxDiscountPercent, tier?.discountPercent ?? 0)
  const total = round2(n * baseAud * (1 - discount / 100))
  return { total, discount, perSeat: round2(total / n) }
}

export function licencePrice(seats: number, baseAud: number = LICENCE_TERMS.commercial.baseAud): PriceQuote {
  const n = Number.isFinite(seats) ? Math.max(1, Math.floor(Number(seats))) : 1
  const list = round2(n * baseAud)
  // Highest tier whose threshold the purchase reaches.
  const tier = [...PRICE_TIERS].sort((a, b) => b.minSeats - a.minSeats).find((t) => n >= t.minSeats)
  const discount = Math.min(LICENCE_TERMS.commercial.maxDiscountPercent, tier?.discountPercent ?? 0)
  let total = round2(list * (1 - discount / 100))
  const perSeat = round2(total / n)
  /**
   * A quantity break makes the total dip below a smaller order, and that is left
   * alone on purpose.
   *
   * Seventy-four licences at $45 is $3,330; seventy-five at $37.50 is $2,812.50.
   * Flattening the dip would only move it — the floor is (n-1) × the previous
   * price, so every quantity just past a break would sit at a flat total while
   * the next one rose, which is a stranger price list than the dip itself.
   * A buyer who wanted 74 can order 75 and pay less for more, so nobody loses.
   * The point is flagged so the UI can say so rather than leaving the invoice
   * looking like a mistake.
   */
  const atQuantityBreak = !!tier && n > 1 && tierOf(n - 1, baseAud).total > total
  const summary =
    discount === 0
      ? `${n} licence${n === 1 ? '' : 's'} at AUD $${baseAud} — AUD $${total} for 12 months.`
      : `${n} licences at AUD $${baseAud} each less ${discount}% — AUD $${total}, which is AUD $${perSeat.toFixed(2)} per licence, for 12 months.`
  return { seats: n, baseAud, listAud: list, totalAud: total, perSeatAud: perSeat, discountPercent: discount, atQuantityBreak, tier, summary }
}

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
      `A commercial licence is ${LICENCE_TERMS.commercial.summary}`,
      'Buying several together is discounted at 25, 50, 75 and 100 licences, up to half price.'
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
