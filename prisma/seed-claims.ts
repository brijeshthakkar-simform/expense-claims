// Demo claims C01–C12 (C-15, 03 §12.3), built through the REAL services, so every snapshot, step
// and event is genuine and every trigger checks it. A SeedClock (ServiceCtx.clock) backdates the
// transition timestamps; the DB keeps them only when this runs as the owner (prisma/seed.ts sets
// DATABASE_URL to the owner URL). Run as expense_app (TC-I16 calls seedDemoClaims() directly) the
// DB stamps now() instead and everything else is identical.
//
// Claims are created strictly in C01..C12 order, so on a fresh volume the claim numbers line up
// (C06 = EXP-2026-000006); each one's whole story is played before the next is created.
//
// One receipt is seeded: C04's first line, uploaded through the real receipts service (so the
// object goes to ReceiptStorage) before C04 is submitted. The tools `release` runs ensure-bucket
// before the seed, so the bucket exists by then.
import { randomUUID } from 'node:crypto';
import type { Actor } from '@/server/auth/actor';
import { getDb } from '@/server/db/client';
import { env } from '@/server/env';
import * as approvalsService from '@/server/services/approvals.service';
import * as claimsService from '@/server/services/claims.service';
import type { SeedClock, ServiceCtx } from '@/server/services/context';
import * as lifecycleService from '@/server/services/lifecycle.service';
import * as receiptsService from '@/server/services/receipts.service';

const CAST_EMAILS = {
  asha: 'asha.rao@acme.test',
  ravi: 'ravi.menon@acme.test',
  meera: 'meera.iyer@acme.test',
  vikram: 'vikram.shah@acme.test',
  deepa: 'deepa.menon@acme.test',
  neha: 'neha.kapoor@acme.test',
  arjun: 'arjun.das@acme.test',
  farah: 'farah.khan@acme.test',
} as const;
type Who = keyof typeof CAST_EMAILS;

export type DemoClaimKey =
  'C01' | 'C02' | 'C03' | 'C04' | 'C05' | 'C06' | 'C07' | 'C08' | 'C09' | 'C10' | 'C11' | 'C12';

/** An IST wall-clock instant, e.g. ist('2026-10-06 09:30') or ist('2026-09-15 16:42:10'). */
const ist = (local: string): Date =>
  new Date(`${local.replace(' ', 'T')}${local.length === 16 ? ':00' : ''}+05:30`);

/** A clock the seed moves forward between service calls. */
class SettableClock implements SeedClock {
  private at = new Date();
  set(local: string): this {
    this.at = ist(local);
    return this;
  }
  now(): Date {
    return new Date(this.at);
  }
}

async function loadActors(): Promise<Record<Who, Actor>> {
  const rows = await getDb().user.findMany({
    where: { email: { in: Object.values(CAST_EMAILS) }, isActive: true },
    select: { id: true, email: true, name: true, role: true, canApprove: true },
  });
  const byEmail = new Map(rows.map((r) => [r.email, r]));
  return Object.fromEntries(
    Object.entries(CAST_EMAILS).map(([who, email]) => {
      const a = byEmail.get(email);
      if (!a) throw new Error(`demo claims need the cast: ${email} is missing`);
      return [who, a];
    }),
  ) as Record<Who, Actor>;
}

async function categoryIds(): Promise<Record<string, string>> {
  const rows = await getDb().category.findMany({ select: { code: true, id: true } });
  return Object.fromEntries(rows.map((r) => [r.code, r.id]));
}

/**
 * A small, valid one-page PDF (Helvetica text, exact xref offsets) for the seeded receipt. ASCII
 * only, so string offsets are byte offsets.
 */
function receiptPdf(lines: readonly string[]): Uint8Array<ArrayBuffer> {
  const esc = (t: string) => t.replace(/[\\()]/g, (ch) => `\\${ch}`);
  const text = lines
    .map((l, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 56 ${780 - i * 24} Td (${esc(l)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
      '/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}

/**
 * Seeds the demo claims for the cast and returns their ids. Not idempotent: prisma/seed.ts calls it
 * only right after seeding the cast into an empty users table.
 */
export async function seedDemoClaims(): Promise<Record<DemoClaimKey, string>> {
  const actors = await loadActors();
  const cats = await categoryIds();
  const clock = new SettableClock();
  const ctx = (who: Who): ServiceCtx => ({
    actor: actors[who],
    requestId: `seed-${randomUUID()}`,
    clock,
  });

  // C01: Asha's editable DRAFT, rev 0. create → PUT one line (the DB maintains the total).
  clock.set('2026-10-05 13:30');
  const c01 = await claimsService.createClaim(ctx('asha'), { title: 'Team lunch' });
  clock.set('2026-10-05 13:35');
  await claimsService.replaceClaim(ctx('asha'), c01.id, {
    title: 'Team lunch',
    lineItems: [
      {
        expenseDate: '2026-10-05',
        categoryId: cats.MEALS!,
        amountMinor: 120_000, // ₹1,200
        description: 'Team lunch after the sprint review',
        merchant: 'Meghana Foods',
      },
    ],
  });

  /** A claim with lines through the real create service (the DB derives its total). */
  const create = (
    who: Who,
    at: string,
    title: string,
    lines: {
      date: string;
      category: string;
      amountMinor: number;
      description: string;
      merchant?: string;
    }[],
  ) => {
    clock.set(at);
    return claimsService.createClaim(ctx(who), {
      title,
      lineItems: lines.map((l) => ({
        expenseDate: l.date,
        categoryId: cats[l.category]!,
        amountMinor: l.amountMinor,
        description: l.description,
        merchant: l.merchant,
      })),
    });
  };
  const submit = (who: Who, at: string, claimId: string) => {
    clock.set(at);
    return lifecycleService.submit(ctx(who), claimId);
  };
  // Decisions pin the revision the approver reviewed (D-17), exactly as the UI sends it.
  const approve = (who: Who, at: string, c: { id: string; currentRevision: number }) => {
    clock.set(at);
    return approvalsService.approve(ctx(who), c.id, { revision: c.currentRevision });
  };
  const reject = (
    who: Who,
    at: string,
    c: { id: string; currentRevision: number },
    reason: string,
  ) => {
    clock.set(at);
    return approvalsService.reject(ctx(who), c.id, { revision: c.currentRevision, reason });
  };
  const recall = (who: Who, at: string, claimId: string, note?: string) => {
    clock.set(at);
    return lifecycleService.recall(ctx(who), claimId, { note });
  };

  // C02: ₹8,000 → submit → PENDING with Ravi (1 step). The out-of-queue target for Neha (TC-I17).
  const c02 = await create('asha', '2026-10-06 09:10', 'Cab to client site', [
    {
      date: '2026-10-02',
      category: 'LOCAL_TRANSPORT',
      amountMinor: 800_000, // ₹8,000
      description: 'Cabs to and from the Pune client site, 4 days',
      merchant: 'Uber',
    },
  ]);
  await submit('asha', '2026-10-06 09:30', c02.id);

  // C03: ₹25,000 → [ravi, meera] → Ravi approves L1 → PENDING with Meera (mid-chain).
  const c03 = await create('asha', '2026-10-07 10:00', 'Client workshop travel', [
    {
      date: '2026-10-01',
      category: 'TRAVEL_AIR',
      amountMinor: 1_850_000, // ₹18,500
      description: 'Return flight Bengaluru to Mumbai for the client workshop',
      merchant: 'IndiGo',
    },
    {
      date: '2026-10-02',
      category: 'LODGING',
      amountMinor: 650_000, // ₹6,500
      description: 'One night near the client office',
      merchant: 'Taj Lands End',
    },
  ]);
  const c03r1 = await submit('asha', '2026-10-07 10:15', c03.id);
  await approve('ravi', '2026-10-08 11:20', c03r1);

  // C04: ₹75,000 → [ravi, meera, vikram], all approve → APPROVED on 2026-09-15 (locked-claim demo).
  const c04 = await create('asha', '2026-09-10 09:00', 'Annual tech conference', [
    {
      date: '2026-09-02',
      category: 'TRAINING',
      amountMinor: 4_500_000, // ₹45,000
      description: 'Conference pass, three days',
      merchant: 'DevSummit India',
    },
    {
      date: '2026-09-03',
      category: 'LODGING',
      amountMinor: 3_000_000, // ₹30,000
      description: 'Hotel for the conference, three nights',
      merchant: 'ITC Gardenia',
    },
  ]);
  // The conference-pass invoice on line 1, before the submit: revision 1's snapshot freezes it, so
  // once C04 is APPROVED a raw `DELETE FROM receipts` on it as expense_app raises UC001 (§7 Q2).
  // Not under the fs fallback driver: this job doesn't mount the app's receipt volume (01 §11.3).
  const pass = c04.lineItems[0];
  if (pass?.category.code !== 'TRAINING') throw new Error('C04 line 1 is not the conference pass');
  if (env().RECEIPT_STORAGE_DRIVER !== 'fs') {
    clock.set('2026-09-10 09:12');
    const pdf = receiptPdf([
      'DevSummit India - Tax invoice DSI-2026-04417',
      'Billed to: Asha Rao, Acme (demo data)',
      'Conference pass, three days, 2-4 September 2026',
      'Amount: INR 45,000.00 (paid by card on 20 Aug 2026)',
    ]);
    const file = new File([pdf], 'devsummit-pass-invoice.pdf', { type: 'application/pdf' });
    await receiptsService.upload(ctx('asha'), c04.id, pass.id, file);
  }
  const c04r1 = await submit('asha', '2026-09-10 09:30', c04.id);
  await approve('ravi', '2026-09-11 10:05', c04r1);
  await approve('meera', '2026-09-14 15:20', c04r1);
  await approve('vikram', '2026-09-15 16:42:10', c04r1);

  // C05: ₹12,000 → [ravi, meera] → Ravi rejects L1 (Meera's WAITING step is cancelled).
  const c05 = await create('asha', '2026-10-04 18:00', 'Hyderabad site visit', [
    {
      date: '2026-10-03',
      category: 'LODGING',
      amountMinor: 900_000, // ₹9,000
      description: 'Hotel, two nights for the site visit',
      merchant: 'Novotel HICC',
    },
    {
      date: '2026-10-03',
      category: 'MEALS',
      amountMinor: 300_000, // ₹3,000
      description: 'Meals during the site visit',
    },
  ]);
  const c05r1 = await submit('asha', '2026-10-04 18:10', c05.id);
  await reject('ravi', '2026-10-05 12:30', c05r1, 'Hotel invoice missing for 3 Oct');

  // C06: rev 1 ₹30,000 → [ravi, meera] → Ravi approves L1 → Meera rejects L2 → Asha edits it down
  // to ₹9,500 (the lodging line keeps its id) → resubmit → rev 2 PENDING with Ravi. History is
  // preserved and the chain shrinks from 2 steps to 1 (CLAIM_RESUBMITTED, previousRevision r1).
  const c06 = await create('asha', '2026-09-24 09:00', 'Mumbai client visit', [
    {
      date: '2026-09-22',
      category: 'TRAVEL_AIR',
      amountMinor: 2_200_000, // ₹22,000
      description: 'Return flight Bengaluru to Mumbai, flexible business fare',
      merchant: 'Air India',
    },
    {
      date: '2026-09-22',
      category: 'LODGING',
      amountMinor: 800_000, // ₹8,000
      description: 'Hotel near the client office, one night',
      merchant: 'Trident Nariman Point',
    },
  ]);
  const c06r1 = await submit('asha', '2026-09-24 09:15', c06.id);
  await approve('ravi', '2026-09-25 10:30', c06r1);
  await reject(
    'meera',
    '2026-09-26 14:45',
    c06r1,
    'Business fare is outside the travel policy; claim the train fare instead',
  );
  const lodging = c06.lineItems.find((l) => l.category.code === 'LODGING');
  if (!lodging) throw new Error('C06 lost its lodging line');
  clock.set('2026-09-29 11:00');
  await claimsService.replaceClaim(ctx('asha'), c06.id, {
    title: 'Mumbai client visit',
    lineItems: [
      {
        id: lodging.id,
        expenseDate: '2026-09-22',
        categoryId: cats.LODGING!,
        amountMinor: 600_000, // ₹6,000: the corporate rate
        description: 'Hotel near the client office, one night (corporate rate)',
        merchant: 'Trident Nariman Point',
      },
      {
        expenseDate: '2026-09-22',
        categoryId: cats.TRAVEL_RAIL!,
        amountMinor: 350_000, // ₹3,500
        description: 'Train Bengaluru to Mumbai and back, AC two-tier',
        merchant: 'IRCTC',
      },
    ],
  });
  await submit('asha', '2026-09-29 11:10', c06.id);

  // C07: ₹25,000 → [ravi, meera] → Ravi approves L1 → Asha recalls: DRAFT rev 1, L1 stays
  // APPROVED on revision 1, Meera's PENDING step is CANCELLED (CLAIM_RECALLED, 1 level voided).
  const c07 = await create('asha', '2026-10-09 10:00', 'Design workshop', [
    {
      date: '2026-10-08',
      category: 'TRAINING',
      amountMinor: 1_800_000, // ₹18,000
      description: 'Facilitator fee for the two-day design workshop',
      merchant: 'Studio Kaleido',
    },
    {
      date: '2026-10-08',
      category: 'MEALS',
      amountMinor: 700_000, // ₹7,000
      description: 'Lunch for the workshop participants, two days',
      merchant: 'Truffles',
    },
  ]);
  const c07r1 = await submit('asha', '2026-10-09 10:20', c07.id);
  await approve('ravi', '2026-10-10 09:45', c07r1);
  await recall('asha', '2026-10-10 15:30', c07.id, 'Adding the venue invoice before it goes on');

  // C08: Arjun ₹5,000 → PENDING with Neha. Foreign to Ravi; Neha's positive control.
  const c08 = await create('arjun', '2026-10-08 14:00', 'Team offsite snacks', [
    {
      date: '2026-10-07',
      category: 'MEALS',
      amountMinor: 500_000, // ₹5,000
      description: 'Snacks and coffee for the team offsite',
      merchant: 'Third Wave Coffee',
    },
  ]);
  await submit('arjun', '2026-10-08 14:05', c08.id);

  // C09: Arjun ₹6,500 → [neha] → Neha approves at 2026-09-30 23:59:30 IST (the last seconds of
  // September: the export boundary, 2026-09-30T18:29:30Z).
  const c09 = await create('arjun', '2026-09-29 18:00', 'Quarter-end client dinner', [
    {
      date: '2026-09-26',
      category: 'CLIENT_ENTERTAINMENT',
      amountMinor: 650_000, // ₹6,500
      description: 'Dinner with the client team after the quarterly review',
      merchant: 'Karavalli',
    },
  ]);
  const c09r1 = await submit('arjun', '2026-09-30 09:00', c09.id);
  await approve('neha', '2026-09-30 23:59:30', c09r1);

  // C10: Asha ₹2,400 → [ravi] → Ravi approves at 2026-10-01 00:15:00 IST (the first minutes of
  // October, 2026-09-30T18:45:00Z: in the October export, not September's).
  const c10 = await create('asha', '2026-09-30 20:00', 'Home broadband, September', [
    {
      date: '2026-09-30',
      category: 'INTERNET_PHONE',
      amountMinor: 240_000, // ₹2,400
      description: 'Home broadband bill for September',
      merchant: 'ACT Fibernet',
    },
  ]);
  const c10r1 = await submit('asha', '2026-09-30 20:10', c10.id);
  await approve('ravi', '2026-10-01 00:15:00', c10r1);

  // C11: Vikram ₹8,000 → PENDING with Deepa as FALLBACK (no manager above the top of the tree).
  const c11 = await create('vikram', '2026-10-09 09:00', 'Board dinner cab', [
    {
      date: '2026-10-08',
      category: 'LOCAL_TRANSPORT',
      amountMinor: 800_000, // ₹8,000
      description: 'Chauffeur service for the board dinner',
      merchant: 'Savaari',
    },
  ]);
  await submit('vikram', '2026-10-09 09:10', c11.id);

  // C12: Farah (FINANCE) as a claimant: ₹3,000 → [deepa] → Deepa approves.
  const c12 = await create('farah', '2026-10-02 17:00', 'Audit courier charges', [
    {
      date: '2026-10-01',
      category: 'MISC',
      amountMinor: 300_000, // ₹3,000
      description: 'Courier of signed audit papers to the auditors',
      merchant: 'Blue Dart',
    },
  ]);
  const c12r1 = await submit('farah', '2026-10-02 17:05', c12.id);
  await approve('deepa', '2026-10-03 10:00', c12r1);

  return {
    C01: c01.id,
    C02: c02.id,
    C03: c03.id,
    C04: c04.id,
    C05: c05.id,
    C06: c06.id,
    C07: c07.id,
    C08: c08.id,
    C09: c09.id,
    C10: c10.id,
    C11: c11.id,
    C12: c12.id,
  };
}
