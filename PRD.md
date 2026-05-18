# Settlement Engine — Closing the Craft Gap

**Author:** Rachel Wang · **Date:** May 2026 · **Status:** Shipped (prototype)

---

## The Problem

82% of Greenroom customers default to spreadsheets for show settlement. The in-app tool only handled 2 of 5 deal types (flat guarantees and percentage-of-gross), leaving vs deals, percentage-of-net, and door deals unsupported. Vs deals alone represent ~50% of deals at venues like The Crescent.

Settlement is the most trust-critical moment between a venue and an artist's team. When the math happens in a Google Sheet at 2am instead of in Greenroom, we're absent from the conversation where venue-artist trust is actually built.

## What Users Told Us

Three compounding pain points from the research:

**The tool can't do the math.** Mariana: "Probably 70% of my deals at this venue are vs deals. Your tool can't do those." She tried the in-app tool in 2023 but had to switch to spreadsheets whenever it hit an unsupported deal — doing the work twice.

**The math isn't auditable.** Diego, a tour manager, won't sign what he can't trace: "If I have to ask 'where did the $14,427 come from' and they have to explain it for ten minutes from memory, I'm not signing that." The existing tool showed a final number but not the derivation.

**Ambiguity surfaces at the worst time.** The Coastal Spell dispute (March 2025) cost $720 and agent goodwill. The deal email was ambiguous; the structured fields in Greenroom didn't capture what mattered. Sarah Kim at WME: "There was no canonical version of what the deal was. The deal was a ghost."

## Why This Slice

I chose **deal math and auditability** because it's the blocking dependency. You can't build a collaborative pre-settlement workflow, structured deal capture, or dispute prevention on top of an engine that returns "unsupported" for half the deals. Get the math right and transparent, and the downstream workflows become possible.

## What I Built

**Settlement engine** (`lib/dealMath.ts`) — extended from 2 to all 5 deal types:
- **Vs deals** — guarantee vs % of net/gross, including walkout pots, tier ratchets, and vs-gross variants. The engine respects `percentageBasis`: vs-gross computes from gross (no expense deductions), vs-net from net.
- **Percentage-of-net** with expense caps and step-by-step deduction
- **Door deals** (gross minus capped expenses)
- Tier ratchet resolution (fill-ratio-based percentage escalation)
- Gross-threshold bonuses on vs deals only fire when the percentage side wins

**VS comparison UI** — a new card on the settlement page showing both sides of the versus side-by-side with a winner badge and plain-English explanation. Designed for Diego at 2am: "I want to see the math."

**Step-by-step derivation** — every supported deal shows intermediate numbers (gross, fees, net, capped expenses, percentage applied, bonuses triggered/not triggered).

**Deal notes on all settlements** — the brief says "the deal notes_freetext field is the truth." Every settlement now shows the free-text deal notes alongside the structured worksheet, so Mariana can cross-reference what she actually agreed to.

**Status inconsistency detection** — 22 of 24 "disputed" settlements in the data have positive sign-off text ("Looks good — TM", "wire monday", "👍"). The settlement page flags this contradiction. Similarly, the 17 vs-gross deals in the seeded data were settled by the seed using net (the seed ignored `percentageBasis`); the engine now computes correctly from gross, and the "Originally settled at" line surfaces the discrepancy.

## Design Decisions

**Backward compatible.** The `SettlementCalculation` type remains a union of `{ supported: true }` and `{ supported: false }`. Existing flat and percentage-of-gross pages render identically.

**Trust through transparency, not simplification.** I show every intermediate step rather than collapsing the math. The audience is not just Mariana — it's Diego across the table at 2am, and Sarah reading the statement the next morning. Hiding the work erodes trust.

**Match the seed's math — except where the data model is right.** For vs-net deals (the majority), the engine produces identical numbers to the seed. For vs-gross deals, the seed ignored `percentageBasis` and always computed from net. The engine now correctly computes from gross, which means it disagrees with 17 pre-seeded settlements. This is intentional: the "Originally settled at" line surfaces the discrepancy as a data inconsistency, the same way the disputed+positive-signoff detection does.

## What I Cut

**Structured deal capture** — replacing free-text notes with a structured form that forces agreement on ambiguous terms at deal time. Important, but requires agent-side UX and workflow changes beyond the settlement page.

**Pre-settlement preview** — letting Mariana share a draft settlement with the tour manager mid-week. Requires the collaborative lifecycle UX that the current draft → submitted → in_review pipeline hints at but doesn't implement.

**Expense aggregation** — connecting to the POS and surfacing missing expenses. Mariana's biggest time sink, but a data-entry problem, not a math problem.

## How I'd Validate

1. **Smoke test against the full dataset.** Run the engine against all ~540 seeded shows and compare output to pre-seeded settlement values. Any disagreement is a bug.

2. **Five-user test with real bookers.** Give them the vs-deal settlement worksheet and ask: "Would you sign this? Can you trace every number?" If Diego's question — "where did this come from?" — is answerable without verbal explanation, the audit trail works.

3. **Track in-app settlement completion rate.** Before vs. after. If the 18% in-app usage rate moves meaningfully on vs-deal shows specifically, the math gap was the blocker. If it doesn't move, the problem is elsewhere (data entry, workflow, trust).

## What's Next

1. **Structured deal capture** — prevent the class of disputes that no amount of good math can fix
2. **Pre-settlement preview** — shift the 2am conversation to Wednesday afternoon
3. **Expense aggregation** — the single biggest time saver for Mariana
