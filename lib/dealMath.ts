/**
 * Deal calculation logic for the in-app settlement tool.
 *
 * Handles all five deal types end-to-end:
 *
 *   1. flat                 — $X guaranteed, optional sellout bonus
 *   2. percentage_of_gross  — X% of gross, no expense deductions
 *   3. percentage_of_net    — X% of net after capped expenses
 *   4. vs                   — guarantee vs % of net/gross, whichever greater
 *   5. door                 — gross minus capped expenses
 *
 * Bonuses are read from `bonusesJson`. Tier ratchets modify the effective
 * percentage before the main calculation. Gross-threshold bonuses on vs deals
 * only apply when the percentage side wins.
 */

import type { Deal, Expense, TicketSale, Bonus } from "@/db/schema";

export type VsBreakdown = {
  guaranteeSide: {
    label: string;
    amount: number;
  };
  percentageSide: {
    label: string;
    calculationBase: number;
    percentage: number;
    amount: number;
  };
  winner: "guarantee" | "percentage";
  basePayout: number;
};

export type SettlementCalculation =
  | {
      supported: true;
      grossBoxOffice: number;
      netBoxOffice: number;
      totalExpenses: number;
      totalToArtist: number;
      steps: { label: string; value: number; note?: string }[];
      finalFormula: string;
      bonusesApplied: { label: string; amount: number; reason: string }[];
      bonusesNotTriggered: { label: string; amount: number; reason: string }[];
      vsBreakdown?: VsBreakdown;
    }
  | {
      supported: false;
      reason: string;
      dealType: Deal["dealType"];
    };

interface CalcInput {
  deal: Deal;
  ticketSales: TicketSale[];
  expenses: Expense[];
  venueCapacity?: number;
  ticketsSold?: number;
}

export function parseBonuses(deal: Deal): Bonus[] {
  if (!deal.bonusesJson) return [];
  try {
    const parsed = JSON.parse(deal.bonusesJson);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Compute capped expenses with a human-readable note. */
function computeCappedExpenses(
  totalExpenses: number,
  expenseCap: number | null,
) {
  const cap = expenseCap ?? Infinity;
  const capped = Math.min(totalExpenses, cap);
  return {
    capped,
    note:
      expenseCap != null && totalExpenses > expenseCap
        ? `Expenses of $${totalExpenses.toLocaleString()} capped at $${expenseCap.toLocaleString()}`
        : expenseCap != null
          ? `Under cap of $${expenseCap.toLocaleString()}`
          : "No expense cap on this deal",
  };
}

/** Resolve a tier_ratchet bonus to determine the effective percentage. */
function resolveTierRatchet(
  bonuses: Bonus[],
  tickets: number,
  capacity: number | undefined,
  basePercentage: number,
): {
  effectivePercentage: number;
  ratchetApplied: boolean;
  label: string;
} | null {
  const ratchet = bonuses.find((b) => b.type === "tier_ratchet");
  if (!ratchet || ratchet.type !== "tier_ratchet") return null;

  if (capacity == null || capacity === 0) {
    return {
      effectivePercentage: basePercentage,
      ratchetApplied: false,
      label: "Capacity unknown — cannot evaluate tier ratchet",
    };
  }

  const fillRatio = tickets / capacity;
  const tiers = ratchet.tiers;
  const matchedTier = tiers.find(
    (t) => fillRatio >= t.from && (t.to === null || fillRatio < t.to),
  );

  if (matchedTier) {
    return {
      effectivePercentage: matchedTier.percentage,
      ratchetApplied: matchedTier.percentage !== basePercentage,
      label: `${(matchedTier.percentage * 100).toFixed(0)}% at ${Math.round(fillRatio * 100)}% sold${matchedTier.percentage !== basePercentage ? ` (ratcheted from ${(basePercentage * 100).toFixed(0)}%)` : ""}`,
    };
  }

  return {
    effectivePercentage: basePercentage,
    ratchetApplied: false,
    label: `No ratchet tier matched at ${Math.round(fillRatio * 100)}% sold`,
  };
}

/** Evaluate a list of bonuses against the show's actual numbers. */
function applyBonuses(
  bonuses: Bonus[],
  ctx: {
    gross: number;
    net: number;
    tickets: number;
    capacity?: number;
    vsWinner?: "guarantee" | "percentage";
  },
) {
  const applied: { label: string; amount: number; reason: string }[] = [];
  const notTriggered: { label: string; amount: number; reason: string }[] = [];

  for (const b of bonuses) {
    if (b.type === "tier_ratchet") {
      // Handled by resolveTierRatchet before this function is called
      continue;
    }

    if (b.type === "gross_threshold") {
      // For vs deals, gross_threshold only applies when percentage side won
      if (ctx.vsWinner === "guarantee") {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            "Guarantee side won — gross threshold bonuses do not apply",
        });
        continue;
      }

      if (ctx.gross >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross $${ctx.gross.toLocaleString()} ≥ $${b.threshold.toLocaleString()}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `Gross $${ctx.gross.toLocaleString()} < $${b.threshold.toLocaleString()}`,
        });
      }
    } else if (b.type === "sellout") {
      if (ctx.capacity != null && ctx.tickets >= ctx.capacity * 0.95) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} of ${ctx.capacity} sold`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason:
            ctx.capacity != null
              ? `${ctx.tickets} of ${ctx.capacity} sold (sellout = ≥95%)`
              : "Capacity unknown — can't evaluate",
        });
      }
    } else if (b.type === "attendance_threshold") {
      if (ctx.tickets >= b.threshold) {
        applied.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} ≥ ${b.threshold}`,
        });
      } else {
        notTriggered.push({
          label: b.label,
          amount: b.amount,
          reason: `${ctx.tickets} < ${b.threshold}`,
        });
      }
    }
  }

  return {
    applied,
    notTriggered,
    totalApplied: applied.reduce((s, b) => s + b.amount, 0),
  };
}

export function calculateSettlement(input: CalcInput): SettlementCalculation {
  const { deal, ticketSales, expenses, venueCapacity, ticketsSold } = input;

  const grossBoxOffice = ticketSales.reduce((sum, t) => sum + t.gross, 0);
  const totalFees = ticketSales.reduce((sum, t) => sum + t.fees, 0);
  const netBoxOffice = grossBoxOffice - totalFees;
  const totalExpenses = expenses
    .filter((e) => !e.absorbedByVenue)
    .reduce((sum, e) => sum + e.amount, 0);

  const tickets =
    ticketsSold ?? ticketSales.reduce((sum, t) => sum + (t.qty ?? 0), 0);

  const bonuses = parseBonuses(deal);
  const bonusCtx = {
    gross: grossBoxOffice,
    net: netBoxOffice,
    tickets,
    capacity: venueCapacity,
  };

  // ---------- flat guarantee ----------
  if (deal.dealType === "flat") {
    if (deal.guaranteeAmount == null) {
      return {
        supported: false,
        reason: "Flat deal is missing a guarantee amount.",
        dealType: deal.dealType,
      };
    }
    const bonusResult = applyBonuses(bonuses, bonusCtx);

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: deal.guaranteeAmount + bonusResult.totalApplied,
      steps: [
        {
          label: "Flat guarantee",
          value: deal.guaranteeAmount,
          note: "No expense deductions. The guarantee is the floor.",
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: bonusResult.applied.length
        ? `flat $${deal.guaranteeAmount.toLocaleString()} + bonuses $${bonusResult.totalApplied.toLocaleString()} = $${(deal.guaranteeAmount + bonusResult.totalApplied).toLocaleString()}`
        : `flat guarantee = $${deal.guaranteeAmount.toLocaleString()}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- percentage of gross ----------
  if (deal.dealType === "percentage_of_gross") {
    if (deal.percentage == null) {
      return {
        supported: false,
        reason: "Percentage-of-gross deal is missing a percentage.",
        dealType: deal.dealType,
      };
    }
    const payout = grossBoxOffice * deal.percentage;
    const bonusResult = applyBonuses(bonuses, bonusCtx);

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout + bonusResult.totalApplied,
      steps: [
        { label: "Gross box office", value: grossBoxOffice },
        {
          label: `× ${(deal.percentage * 100).toFixed(0)}%`,
          value: payout,
          note: "Percentage of gross — no expense deductions.",
        },
        ...bonusResult.applied.map((b) => ({
          label: b.label,
          value: b.amount,
          note: b.reason,
        })),
      ],
      finalFormula: bonusResult.applied.length
        ? `gross × ${deal.percentage} + bonuses = $${(payout + bonusResult.totalApplied).toLocaleString()}`
        : `gross × ${deal.percentage} = $${payout.toLocaleString()}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- percentage of net ----------
  if (deal.dealType === "percentage_of_net") {
    if (deal.percentage == null) {
      return {
        supported: false,
        reason: "Percentage-of-net deal is missing a percentage.",
        dealType: deal.dealType,
      };
    }

    const { capped: cappedExpenses, note: expenseNote } =
      computeCappedExpenses(totalExpenses, deal.expenseCap);
    const netAfterExpenses = Math.max(0, netBoxOffice - cappedExpenses);

    const ratchet = resolveTierRatchet(
      bonuses,
      tickets,
      venueCapacity,
      deal.percentage,
    );
    const effectivePct = ratchet?.effectivePercentage ?? deal.percentage;
    const ratchetNote = ratchet?.ratchetApplied ? ratchet.label : undefined;

    const payout = netAfterExpenses * effectivePct;
    const bonusResult = applyBonuses(bonuses, {
      ...bonusCtx,
      vsWinner: undefined,
    });

    const steps = [
      {
        label: "Expenses after cap",
        value: cappedExpenses,
        note: expenseNote,
      },
      {
        label: "Net after expenses",
        value: netAfterExpenses,
        note:
          netAfterExpenses === 0
            ? "Net fully consumed by expenses"
            : undefined,
      },
      {
        label: `× ${(effectivePct * 100).toFixed(0)}% of net`,
        value: payout,
        note: ratchetNote,
      },
      ...bonusResult.applied.map((b) => ({
        label: b.label,
        value: b.amount,
        note: b.reason,
      })),
    ];

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout + bonusResult.totalApplied,
      steps,
      finalFormula: `net $${netBoxOffice.toLocaleString()} − expenses $${cappedExpenses.toLocaleString()} = $${netAfterExpenses.toLocaleString()} × ${(effectivePct * 100).toFixed(0)}% = $${(payout + bonusResult.totalApplied).toLocaleString()}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- vs deal ----------
  if (deal.dealType === "vs") {
    if (deal.guaranteeAmount == null || deal.percentage == null) {
      return {
        supported: false,
        reason:
          "VS deal is missing guarantee amount or percentage.",
        dealType: deal.dealType,
      };
    }

    const guarantee = deal.guaranteeAmount;
    const basis = deal.percentageBasis ?? "net";

    // Resolve tier ratchet before computing percentage side
    const ratchet = resolveTierRatchet(
      bonuses,
      tickets,
      venueCapacity,
      deal.percentage,
    );
    const effectivePct = ratchet?.effectivePercentage ?? deal.percentage;

    let calculationBase: number;
    let cappedExpenses = 0;
    let expenseNote = "";

    if (basis === "gross") {
      calculationBase = grossBoxOffice;
      expenseNote = "Vs-gross — no expense deductions, percentage of gross";
    } else {
      const capped = computeCappedExpenses(totalExpenses, deal.expenseCap);
      cappedExpenses = capped.capped;
      expenseNote = capped.note;
      calculationBase = Math.max(0, netBoxOffice - cappedExpenses);
    }

    const pctPayout = calculationBase * effectivePct;
    const winner: "guarantee" | "percentage" =
      pctPayout >= guarantee ? "percentage" : "guarantee";
    const basePayout = Math.max(guarantee, pctPayout);

    const bonusResult = applyBonuses(bonuses, {
      ...bonusCtx,
      vsWinner: winner,
    });

    const totalToArtist = basePayout + bonusResult.totalApplied;

    const vsBreakdown: VsBreakdown = {
      guaranteeSide: {
        label: "Guarantee",
        amount: guarantee,
      },
      percentageSide: {
        label: `${(effectivePct * 100).toFixed(0)}% of ${basis}`,
        calculationBase,
        percentage: effectivePct,
        amount: pctPayout,
      },
      winner,
      basePayout,
    };

    const steps: { label: string; value: number; note?: string }[] = [];

    if (basis === "net") {
      steps.push(
        {
          label: "Expenses after cap",
          value: cappedExpenses,
          note: expenseNote,
        },
        {
          label: "Net after expenses",
          value: calculationBase,
        },
      );
    }

    steps.push(
      {
        label: `× ${(effectivePct * 100).toFixed(0)}% of ${basis}`,
        value: pctPayout,
        note: ratchet?.ratchetApplied ? ratchet.label : undefined,
      },
      {
        label: `Guarantee`,
        value: guarantee,
      },
      {
        label:
          winner === "percentage"
            ? `Winner: ${effectivePct * 100}% of ${basis}`
            : "Winner: guarantee",
        value: basePayout,
        note:
          winner === "percentage"
            ? `Percentage side ($${pctPayout.toLocaleString()}) beat guarantee ($${guarantee.toLocaleString()})`
            : `Guarantee ($${guarantee.toLocaleString()}) beat percentage ($${pctPayout.toLocaleString()})`,
      },
      ...bonusResult.applied.map((b) => ({
        label: b.label,
        value: b.amount,
        note: b.reason,
      })),
    );

    const winnerLabel =
      winner === "percentage"
        ? `${(effectivePct * 100).toFixed(0)}% of ${basis} ($${pctPayout.toLocaleString()})`
        : `guarantee ($${guarantee.toLocaleString()})`;

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist,
      steps,
      finalFormula: bonusResult.applied.length
        ? `${winnerLabel} + bonuses $${bonusResult.totalApplied.toLocaleString()} = $${totalToArtist.toLocaleString()}`
        : `${winnerLabel} = $${totalToArtist.toLocaleString()}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
      vsBreakdown,
    };
  }

  // ---------- door deal ----------
  if (deal.dealType === "door") {
    const { capped: cappedExpenses, note: expenseNote } =
      computeCappedExpenses(totalExpenses, deal.expenseCap);
    const payout = Math.max(0, grossBoxOffice - cappedExpenses);
    const bonusResult = applyBonuses(bonuses, bonusCtx);

    const steps = [
      {
        label: "Expenses after cap",
        value: cappedExpenses,
        note: expenseNote,
      },
      {
        label: "Door payout",
        value: payout,
        note: "Gross minus capped expenses",
      },
      ...bonusResult.applied.map((b) => ({
        label: b.label,
        value: b.amount,
        note: b.reason,
      })),
    ];

    return {
      supported: true,
      grossBoxOffice,
      netBoxOffice,
      totalExpenses,
      totalToArtist: payout + bonusResult.totalApplied,
      steps,
      finalFormula: `gross $${grossBoxOffice.toLocaleString()} − expenses $${cappedExpenses.toLocaleString()} = $${(payout + bonusResult.totalApplied).toLocaleString()}`,
      bonusesApplied: bonusResult.applied,
      bonusesNotTriggered: bonusResult.notTriggered,
    };
  }

  // ---------- unknown deal type ----------
  return {
    supported: false,
    dealType: deal.dealType,
    reason: `Unknown deal type "${deal.dealType}" is not supported.`,
  };
}
