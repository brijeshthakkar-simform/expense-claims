// TC-I27 (§3.1-b, §3.4-a, RT-M3, RT-M4, RT-m6): receipts per line item (D-30, D-31; 06 §5).
// Uploads go through the real route (multipart parsing, size cap, magic bytes, sha256), into the
// MemoryReceiptStorage adapter (RECEIPT_STORAGE_DRIVER=memory, reset by resetDb()), and the row is
// written under the owner-scoped claim lock and re-checked by receipts_10_before_write. Approved
// evidence can't change at any layer; previously submitted evidence is never garbage-collected.
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import * as uploadRoute from '@/app/api/v1/claims/[claimId]/line-items/[lineItemId]/receipts/route';
import * as contentRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/content/route';
import * as receiptRoute from '@/app/api/v1/claims/[claimId]/receipts/[receiptId]/route';
import * as claimRoute from '@/app/api/v1/claims/[claimId]/route';
import { RECEIPT_REQUEST_MAX_BYTES } from '@/server/http/multipart';
import { ReceiptDto, type ClaimDetail } from '@/shared/dto/claims';
import { asPersona, type Persona } from '../../helpers/auth';
import { appSql, ownerSql, rejects } from '../../helpers/db';
import {
  approveAs,
  fakePdf,
  lineInput,
  makeDraft,
  memoryStorage,
  pdfForm,
  recallAs,
  rejectAs,
  submitAs,
} from '../../helpers/factories';
import { callRoute, captureLogs, errorOf } from '../../helpers/http';

// ------------------------------------------------------------------------------------ helpers

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const bytesOf = async (f: Blob) => new Uint8Array(await f.arrayBuffer());
const keyPattern = (claimId: string, lineItemId: string) =>
  new RegExp(
    `^receipts/${claimId}/${lineItemId}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
  );

/** A file of `size` bytes that starts with `magic` (the rest is zero padding). */
const fileWith = (magic: number[] | string, size: number, name: string, type: string) => {
  const head = typeof magic === 'string' ? Buffer.from(magic, 'latin1') : Buffer.from(magic);
  return new File([Buffer.concat([head, Buffer.alloc(size - head.length)])], name, { type });
};

const upload = (
  claimId: string,
  lineItemId: string,
  file: File = fakePdf(),
  as: Persona = 'asha',
  headers?: Record<string, string>,
) =>
  callRoute(uploadRoute, 'POST', {
    path: `/api/v1/claims/${claimId}/line-items/${lineItemId}/receipts`,
    params: { claimId, lineItemId },
    body: pdfForm(file),
    as,
    headers,
  });
const download = (claimId: string, receiptId: string, as: Persona = 'asha') =>
  callRoute(contentRoute, 'GET', {
    path: `/api/v1/claims/${claimId}/receipts/${receiptId}/content`,
    params: { claimId, receiptId },
    as,
  });
const remove = (claimId: string, receiptId: string, as: Persona = 'asha') =>
  callRoute(receiptRoute, 'DELETE', {
    path: `/api/v1/claims/${claimId}/receipts/${receiptId}`,
    params: { claimId, receiptId },
    as,
  });
const outcome = async (r: Response) => [r.status, (await errorOf(r)).error.code] as const;
const created = async (r: Response): Promise<ReceiptDto> => {
  expect(r.status, JSON.stringify(await r.clone().json())).toBe(201);
  return ((await r.json()) as { data: ReceiptDto }).data;
};

interface ReceiptRow {
  id: string;
  line_item_id: string;
  storage_key: string;
  file_name: string;
  content_type: string;
  size_bytes: number;
  sha256: string;
}
const receiptRows = (claimId: string) => ownerSql<ReceiptRow>`
  SELECT id, line_item_id, storage_key, file_name, content_type, size_bytes, sha256
    FROM receipts WHERE claim_id = ${claimId} ORDER BY created_at, id`;
/** Every receipt row of the claim as text: a refusal must leave it byte-identical. */
const receiptsText = async (claimId: string) =>
  (
    await ownerSql<{ s: string | null }>`
      SELECT json_agg(r ORDER BY r.id)::text AS s FROM receipts r WHERE r.claim_id = ${claimId}`
  )[0]!.s;

const getClaim = async (id: string, as: Persona = 'asha') => {
  const res = await callRoute(claimRoute, 'GET', {
    path: `/api/v1/claims/${id}`,
    params: { claimId: id },
    as,
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { data: ClaimDetail }).data;
};

// -------------------------------------------------------------------------------------- tests

describe('TC-I27 receipts per line item', () => {
  it('owner uploads a PDF to a DRAFT line → 201 with sha256', async () => {
    const asha = await asPersona('asha');
    const c = await makeDraft('asha', {
      lines: [
        { amountMinor: 120_000, description: 'Taxi' },
        { amountMinor: 30_000, description: 'Lunch' },
      ],
    });
    const line = c.lineItems[0]!;
    const file = fakePdf(4_096, 'Taxi receipt.pdf');
    const bytes = await bytesOf(file);

    const res = await upload(c.id, line.id, file);
    expect(res.headers.get('x-request-id')).toBeTruthy();
    const dto = await created(res);
    expect(dto).toEqual({
      id: expect.any(String),
      fileName: 'Taxi receipt.pdf',
      contentType: 'application/pdf',
      sizeBytes: 4_096,
      createdAt: expect.any(String),
    }); // the C-10 DTO exactly: no storage key or hash leaves the server
    expect(ReceiptDto.safeParse(dto).success).toBe(true);

    // The row carries the evidence hash and a fresh, PII-free key bound to this claim and line
    const [row, ...more] = await receiptRows(c.id);
    expect(more).toEqual([]);
    expect(row).toMatchObject({
      id: dto.id,
      line_item_id: line.id,
      file_name: 'Taxi receipt.pdf',
      content_type: 'application/pdf',
      size_bytes: 4_096,
      sha256: sha256(bytes),
    });
    expect(row!.storage_key).toMatch(keyPattern(c.id, line.id));
    expect(row!.storage_key).not.toContain('Taxi');
    expect(await ownerSql`SELECT uploaded_by_id FROM receipts WHERE id = ${dto.id}`).toEqual([
      { uploaded_by_id: asha.id },
    ]);

    // The stored object: those exact bytes, with the sniffed type and the same hash
    expect(memoryStorage().keys()).toEqual([row!.storage_key]);
    const stored = memoryStorage().read(row!.storage_key)!;
    expect(sha256(stored.body)).toBe(row!.sha256);
    expect(stored).toMatchObject({ contentType: 'application/pdf', sha256: row!.sha256 });

    // The claim detail lists it under its line only
    const detail = await getClaim(c.id);
    expect(detail.lineItems.find((l) => l.id === line.id)!.receipts).toEqual([dto]);
    expect(detail.lineItems.find((l) => l.id !== line.id)!.receipts).toEqual([]);

    // Submitting freezes the key and hash into the snapshot (claim_submissions_verify v2 agrees)
    await submitAs('asha', c);
    const [sub] = await ownerSql<{ snapshot: { lines: { receipts: unknown[] }[] } }>`
      SELECT snapshot FROM claim_submissions WHERE claim_id = ${c.id} AND revision = 1`;
    expect(sub!.snapshot.lines.flatMap((l) => l.receipts)).toEqual([
      {
        receiptId: dto.id,
        fileName: 'Taxi receipt.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4_096,
        sha256: row!.sha256,
        storageKey: row!.storage_key,
      },
    ]);
  });

  it('SUBMITTED → 409 CLAIM_NOT_EDITABLE; APPROVED → 409 CLAIM_LOCKED', async () => {
    // ₹8,000 → [ravi]: one approval makes it APPROVED
    let c = await makeDraft('asha', { lines: [{ amountMinor: 800_000, receipt: fakePdf() }] });
    const line = c.lineItems[0]!;
    const receipt = line.receipts[0]!;
    const keys = memoryStorage().keys();
    expect(keys).toHaveLength(1);

    c = await submitAs('asha', c);
    expect(c.allowedActions).toEqual(['RECALL']); // no EDIT: the UI shows no attach/remove
    const rows = await receiptsText(c.id);
    for (const send of [() => upload(c.id, line.id), () => remove(c.id, receipt.id)]) {
      const res = await send();
      expect(res.status).toBe(409);
      expect((await errorOf(res)).error).toMatchObject({
        code: 'CLAIM_NOT_EDITABLE',
        details: { hint: 'RECALL_TO_EDIT' },
      });
    }
    expect(await receiptsText(c.id)).toBe(rows);
    expect(memoryStorage().keys()).toEqual(keys); // refused before any byte was stored

    c = await approveAs('ravi', c);
    expect(c).toMatchObject({ status: 'APPROVED', allowedActions: [] });
    for (const send of [
      () => upload(c.id, line.id),
      () => remove(c.id, receipt.id),
      () => upload(c.id, randomUUID()), // the lock is checked before the line
      () => remove(c.id, randomUUID()),
    ]) {
      const res = await send();
      expect(res.status).toBe(409);
      expect((await errorOf(res)).error).toMatchObject({
        code: 'CLAIM_LOCKED',
        details: { status: 'APPROVED' },
      });
    }
    expect(await receiptsText(c.id)).toBe(rows);
    expect(memoryStorage().keys()).toEqual(keys);

    // The evidence is still readable, unchanged
    const res = await download(c.id, receipt.id);
    expect(res.status).toBe(200);
    expect(sha256(await bytesOf(await res.blob()))).toBe((await receiptRows(c.id))[0]!.sha256);
  });

  it('an .exe renamed to .pdf returns 422 RECEIPT_TYPE_NOT_ALLOWED', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 10_000 }] });
    const line = c.lineItems[0]!;
    const refused: Record<string, File> = {
      '.exe renamed to .pdf': fileWith(
        'MZ\x90\x00\x03\x00',
        2_048,
        'invoice.pdf',
        'application/pdf',
      ),
      'HTML labelled image/png': fileWith('<html><script>', 2_048, 'receipt.png', 'image/png'),
      'SVG (not allowlisted)': fileWith(
        '<svg xmlns="http://www.w3.org/2000/svg">',
        512,
        'r.svg',
        'image/svg+xml',
      ),
      'a real PDF declared as image/jpeg': fileWith('%PDF-1.7\n', 2_048, 'r.jpg', 'image/jpeg'),
      'a real PNG declared as octet-stream': fileWith(
        [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        2_048,
        'r.png',
        'application/octet-stream',
      ),
      'no declared type': fileWith('%PDF-1.7\n', 2_048, 'r.pdf', ''),
    };
    for (const [name, file] of Object.entries(refused)) {
      const res = await upload(c.id, line.id, file);
      expect([name, ...(await outcome(res))]).toEqual([name, 422, 'RECEIPT_TYPE_NOT_ALLOWED']);
    }
    expect(await receiptRows(c.id)).toEqual([]);
    expect(memoryStorage().size).toBe(0); // nothing was stored

    // Positive controls: each allowlisted type whose magic bytes agree, stored as the sniffed type
    const accepted: [number[] | string, string, string][] = [
      ['%PDF-1.4\n', 'a.pdf', 'application/pdf'],
      [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'b.png', 'image/png'],
      [[0xff, 0xd8, 0xff, 0xe0], 'c.jpg', 'image/jpeg'],
      ['RIFF\x00\x10\x00\x00WEBPVP8 ', 'd.webp', 'image/webp'],
    ];
    for (const [magic, name, type] of accepted) {
      const dto = await created(await upload(c.id, line.id, fileWith(magic, 1_024, name, type)));
      expect(dto).toMatchObject({ fileName: name, contentType: type });
    }
    expect(memoryStorage().size).toBe(4);
  });

  it('a file over 10 MiB returns 413 PAYLOAD_TOO_LARGE', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 10_000 }] });
    const line = c.lineItems[0]!;

    // 10 MiB + 1 byte: within the request cap, refused by the file-size rule
    expect(await outcome(await upload(c.id, line.id, fakePdf(10_485_761)))).toEqual([
      413,
      'PAYLOAD_TOO_LARGE',
    ]);
    // 11 MiB with no Content-Length: the byte-counting stream stops reading at the cap
    expect(await outcome(await upload(c.id, line.id, fakePdf(11 * 1024 * 1024)))).toEqual([
      413,
      'PAYLOAD_TOO_LARGE',
    ]);
    // A declared Content-Length over the cap is refused before the body is read
    expect(
      await outcome(
        await upload(c.id, line.id, fakePdf(), 'asha', {
          'content-length': String(RECEIPT_REQUEST_MAX_BYTES + 1),
        }),
      ),
    ).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(await receiptRows(c.id)).toEqual([]);
    expect(memoryStorage().size).toBe(0);

    // Exactly 10 MiB is allowed (≤ 10,485,760 bytes, C-14)
    const dto = await created(await upload(c.id, line.id, fakePdf(10_485_760)));
    expect(dto.sizeBytes).toBe(10_485_760);
    expect(memoryStorage().size).toBe(1);
  });

  it('a 9.9 MiB PDF uploads successfully', async () => {
    const c = await makeDraft('asha', { lines: [{ amountMinor: 10_000 }] });
    const file = fakePdf(10_380_902, 'scan.pdf');
    const expected = sha256(await bytesOf(file));

    const dto = await created(await upload(c.id, c.lineItems[0]!.id, file));
    expect(dto).toMatchObject({ fileName: 'scan.pdf', sizeBytes: 10_380_902 });
    expect((await receiptRows(c.id))[0]).toMatchObject({
      size_bytes: 10_380_902,
      sha256: expected,
    });

    // and comes back byte-identical
    const res = await download(c.id, dto.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-length')).toBe('10380902');
    expect(sha256(await bytesOf(await res.blob()))).toBe(expected);
  });

  it('the 6th receipt on a line returns 422 RECEIPT_LIMIT_REACHED', async () => {
    const c = await makeDraft('asha', {
      lines: [{ amountMinor: 10_000 }, { amountMinor: 20_000 }],
    });
    const [line, other] = c.lineItems as [
      ClaimDetail['lineItems'][number],
      ClaimDetail['lineItems'][number],
    ];
    for (let i = 1; i <= 4; i++)
      await created(await upload(c.id, line.id, fakePdf(1_024, `r${i}.pdf`)));

    // Two uploads race for the 5th slot: the re-check under the claim lock lets exactly one in
    const raced = await Promise.all([
      upload(c.id, line.id, fakePdf(1_024, 'r5a.pdf')),
      upload(c.id, line.id, fakePdf(1_024, 'r5b.pdf')),
    ]);
    expect(raced.map((r) => r.status).sort()).toEqual([201, 422]);
    const loser = raced.find((r) => r.status === 422)!;
    expect((await errorOf(loser)).error.code).toBe('RECEIPT_LIMIT_REACHED');

    const sixth = await upload(c.id, line.id, fakePdf(1_024, 'r6.pdf'));
    expect(await outcome(sixth)).toEqual([422, 'RECEIPT_LIMIT_REACHED']);

    const rows = await receiptRows(c.id);
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.line_item_id === line.id)).toBe(true);
    // the loser's object (if it got that far) was removed again: one object per row, no orphans
    expect(memoryStorage().keys()).toEqual(rows.map((r) => r.storage_key).sort());

    // The limit is per line
    await created(await upload(c.id, other.id, fakePdf(1_024, 'other.pdf')));
    // and a removed receipt frees its slot
    expect((await remove(c.id, rows[0]!.id)).status).toBe(204);
    await created(await upload(c.id, line.id, fakePdf(1_024, 'r6.pdf')));
    expect(await receiptRows(c.id)).toHaveLength(6);
  });

  it('download: owner, chain approvers and finance 200; unrelated approver 404', async () => {
    const name = 'Hotel – März.pdf'; // non-ASCII: the ASCII fallback plus filename*
    const pdf = fakePdf(3_000, name);
    const expected = sha256(await bytesOf(pdf));
    // ₹25,000 → [ravi, meera]
    let c = await makeDraft('asha', {
      title: 'Offsite in Pune',
      lines: [{ amountMinor: 2_500_000, receipt: pdf }],
    });
    const receiptId = c.lineItems[0]!.receipts[0]!.id;
    c = await submitAs('asha', c);

    const get = async (as: Persona) => {
      const res = await download(c.id, receiptId, as);
      return { as, status: res.status, res };
    };
    // Meera's step is still WAITING: she can't see the claim yet, so nor its receipts
    expect(await outcome((await get('meera')).res)).toEqual([404, 'CLAIM_NOT_FOUND']);

    c = await approveAs('ravi', c); // Ravi decided, Meera PENDING
    for (const as of ['asha', 'ravi', 'meera', 'farah'] as const) {
      const { status, res } = await get(as);
      expect([as, status]).toEqual([as, 200]);
      expect(Object.fromEntries(res.headers)).toMatchObject({
        'content-type': 'application/pdf', // the stored (sniffed) type
        'content-length': '3000',
        'content-disposition': `attachment; filename="Hotel _ M_rz.pdf"; filename*=UTF-8''Hotel%20%E2%80%93%20M%C3%A4rz.pdf`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      });
      expect(sha256(await bytesOf(await res.blob()))).toBe(expected);
    }

    // Unrelated approver (and admin, who has no extra visibility): the same 404 as a random claim
    const strip = async (r: Response) => {
      const b = (await r.json()) as { error: Record<string, unknown> };
      delete b.error.requestId;
      return { status: r.status, b };
    };
    const random = await strip(await download(randomUUID(), receiptId, 'neha'));
    expect(random).toMatchObject({ status: 404, b: { error: { code: 'CLAIM_NOT_FOUND' } } });
    for (const as of ['neha', 'admin'] as const) {
      const real = await strip(await download(c.id, receiptId, as));
      expect([as, real]).toEqual([as, random]);
      expect(JSON.stringify(real)).not.toContain('Offsite in Pune');
    }

    // On a visible claim, a receipt that isn't one of its own is 404 RECEIPT_NOT_FOUND
    for (const id of [randomUUID(), 'not-a-uuid'])
      expect(await outcome(await download(c.id, id, 'ravi'))).toEqual([404, 'RECEIPT_NOT_FOUND']);
  });

  it('raw DELETE FROM receipts on an APPROVED claim raises UC001', async () => {
    let c = await makeDraft('asha', { lines: [{ amountMinor: 800_000, receipt: fakePdf() }] });
    const line = c.lineItems[0]!;
    const receipt = line.receipts[0]!;
    c = await approveAs('ravi', await submitAs('asha', c));
    expect(c.status).toBe('APPROVED');
    const before = await receiptsText(c.id);
    const asha = await asPersona('asha');

    // Detach, attach or alter evidence as the app role: the trigger refuses (UC001) …
    await rejects('UC001', () => appSql`DELETE FROM receipts WHERE id = ${receipt.id}`);
    await rejects('UC001', () => appSql`DELETE FROM receipts WHERE claim_id = ${c.id}`);
    await rejects(
      'UC001',
      () => appSql`
        INSERT INTO receipts (claim_id, line_item_id, storage_key, file_name, content_type,
                              size_bytes, sha256, uploaded_by_id)
        VALUES (${c.id}, ${line.id}, ${`receipts/${c.id}/${line.id}/${randomUUID()}`},
                'forged.pdf', 'application/pdf', 10, ${'0'.repeat(64)}, ${asha.id})`,
    );
    // … and there is no UPDATE grant at all: evidence is never rewritten in place (C-16)
    await rejects(
      '42501',
      () => appSql`UPDATE receipts SET sha256 = ${'0'.repeat(64)} WHERE id = ${receipt.id}`,
    );
    // "Any role": the owner, who holds every grant, hits the same wall
    await rejects('UC001', () => ownerSql`DELETE FROM receipts WHERE id = ${receipt.id}`);
    await rejects(
      'UC001',
      () =>
        ownerSql`UPDATE receipts SET storage_key = 'receipts/elsewhere' WHERE id = ${receipt.id}`,
    );
    expect(await receiptsText(c.id)).toBe(before);
    expect(memoryStorage().size).toBe(1);

    // While SUBMITTED the content is frozen too (UC002), and a receipt never moves (UC010)
    const submitted = await submitAs(
      'asha',
      await makeDraft('asha', { lines: [{ amountMinor: 800_000, receipt: fakePdf() }] }),
    );
    await rejects('UC002', () => appSql`DELETE FROM receipts WHERE claim_id = ${submitted.id}`);
    const draft = await makeDraft('asha', {
      lines: [{ amountMinor: 1_000, receipt: fakePdf() }, { amountMinor: 2_000 }],
    });
    const [withReceipt, without] = [...draft.lineItems].sort(
      (a, b) => b.receipts.length - a.receipts.length,
    );
    await rejects(
      'UC010',
      () => ownerSql`UPDATE receipts SET line_item_id = ${without!.id}
                      WHERE line_item_id = ${withReceipt!.id}`,
    );
  });

  it('deleting a receipt on a previously submitted claim keeps the object', async () => {
    const logs = captureLogs();
    try {
      // Never submitted (current_revision = 0): nothing can reference it, so the object goes
      const draft = await makeDraft('asha', {
        lines: [{ amountMinor: 1_000, receipt: fakePdf() }],
      });
      const [draftRow] = await receiptRows(draft.id);
      expect((await remove(draft.id, draftRow!.id)).status).toBe(204);
      expect(await receiptRows(draft.id)).toEqual([]);
      expect(memoryStorage().has(draftRow!.storage_key)).toBe(false);

      // Submitted once, then recalled: a DRAFT again, but revision 1's snapshot references it
      let c = await makeDraft('asha', {
        lines: [{ amountMinor: 800_000, receipt: fakePdf(2_048, 'kept.pdf') }],
      });
      const [row] = await receiptRows(c.id);
      c = await recallAs('asha', await submitAs('asha', c));
      expect(c).toMatchObject({ status: 'DRAFT', currentRevision: 1 });
      expect(c.allowedActions).toContain('EDIT');

      const res = await remove(c.id, row!.id);
      expect(res.status).toBe(204);
      expect(await receiptRows(c.id)).toEqual([]); // the row is gone …
      expect(memoryStorage().has(row!.storage_key)).toBe(true); // … the object is kept (D-31)
      expect((await getClaim(c.id)).lineItems[0]!.receipts).toEqual([]);
      // and the revision-1 evidence is still served, byte-identical
      const old = await download(c.id, row!.id);
      expect(old.status).toBe(200);
      expect(old.headers.get('content-disposition')).toContain('filename="kept.pdf"');
      expect(sha256(await bytesOf(await old.blob()))).toBe(row!.sha256);

      const deleted = logs.lines.filter((l) => l.event === 'receipt.deleted');
      expect(deleted.map((l) => [l.receiptId, l.objectDeleted])).toEqual([
        [draftRow!.id, true],
        [row!.id, false],
      ]);
      // the same rule on a REJECTED claim
      let r = await makeDraft('asha', { lines: [{ amountMinor: 800_000, receipt: fakePdf() }] });
      const [rejectedRow] = await receiptRows(r.id);
      r = await rejectAs('ravi', await submitAs('asha', r));
      expect((await remove(r.id, rejectedRow!.id)).status).toBe(204);
      expect(memoryStorage().has(rejectedRow!.storage_key)).toBe(true);
    } finally {
      logs.stop();
    }

    // The PUT replace-set and the draft delete follow the same rule (C-25 receipt-key steps)
    const fresh = await makeDraft('asha', {
      lines: [
        { amountMinor: 1_000, receipt: fakePdf() },
        { amountMinor: 2_000, receipt: fakePdf() },
      ],
    });
    const freshRows = await receiptRows(fresh.id);
    const kept = fresh.lineItems.find((l) => l.id === freshRows[1]!.line_item_id)!;
    const put = await callRoute(claimRoute, 'PUT', {
      path: `/api/v1/claims/${fresh.id}`,
      params: { claimId: fresh.id },
      body: { title: fresh.title, lineItems: [lineInput(kept)] },
      as: 'asha',
    });
    expect(put.status).toBe(200);
    expect(memoryStorage().has(freshRows[0]!.storage_key)).toBe(false); // removed line, never submitted
    expect(memoryStorage().has(freshRows[1]!.storage_key)).toBe(true);
    const del = await callRoute(claimRoute, 'DELETE', {
      path: `/api/v1/claims/${fresh.id}`,
      params: { claimId: fresh.id },
      as: 'asha',
    });
    expect(del.status).toBe(204);
    expect(memoryStorage().has(freshRows[1]!.storage_key)).toBe(false); // the whole draft went
  });

  it('a failed DB insert deletes the uploaded object', async () => {
    const storage = memoryStorage();
    const putKeys: string[] = [];

    // Another tab submits the claim while the bytes are in flight: the re-check under the lock
    // refuses the INSERT, and the object nothing references is deleted again
    const c = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    const line = c.lineItems[0]!;
    storage.onPut = async (key) => {
      putKeys.push(key);
      storage.onPut = undefined;
      await submitAs('asha', c);
    };
    expect(await outcome(await upload(c.id, line.id))).toEqual([409, 'CLAIM_NOT_EDITABLE']);
    expect(putKeys).toHaveLength(1);
    expect(putKeys[0]).toMatch(keyPattern(c.id, line.id));
    expect(storage.has(putKeys[0]!)).toBe(false);
    expect(await receiptRows(c.id)).toEqual([]);

    // The line is removed in another tab between the put and the commit: 404, object deleted
    const d = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }, { amountMinor: 2_000 }] });
    const [gone, stays] = d.lineItems as [
      ClaimDetail['lineItems'][number],
      ClaimDetail['lineItems'][number],
    ];
    storage.onPut = async (key) => {
      putKeys.push(key);
      storage.onPut = undefined;
      const put = await callRoute(claimRoute, 'PUT', {
        path: `/api/v1/claims/${d.id}`,
        params: { claimId: d.id },
        body: { title: d.title, lineItems: [lineInput(stays)] },
        as: 'asha',
      });
      expect(put.status).toBe(200);
    };
    expect(await outcome(await upload(d.id, gone.id))).toEqual([404, 'LINE_ITEM_NOT_FOUND']);
    expect(storage.has(putKeys[1]!)).toBe(false);
    expect(storage.size).toBe(0);

    // If that compensating delete fails, the request still gets its real error and the orphan is
    // logged with its key (harmless: nothing references it, 06 §5.8)
    const e = await makeDraft('asha', { lines: [{ amountMinor: 800_000 }] });
    storage.onPut = async (key) => {
      putKeys.push(key);
      storage.onPut = undefined;
      storage.faults.delete = new Error('object store unreachable');
      await submitAs('asha', e);
    };
    const logs = captureLogs();
    try {
      expect(await outcome(await upload(e.id, e.lineItems[0]!.id))).toEqual([
        409,
        'CLAIM_NOT_EDITABLE',
      ]);
      expect(logs.lines.filter((l) => l.event === 'receipt.object_orphaned')).toEqual([
        expect.objectContaining({ level: 'warn', storageKey: putKeys[2], claimId: e.id }),
      ]);
    } finally {
      logs.stop();
      storage.faults = {};
    }
    expect(storage.keys()).toEqual([putKeys[2]]);
    expect(await receiptRows(e.id)).toEqual([]);

    // A store that is down when the bytes are written: 503, and no row
    const f = await makeDraft('asha', { lines: [{ amountMinor: 1_000 }] });
    storage.faults.put = new Error('connection refused');
    const down = await upload(f.id, f.lineItems[0]!.id);
    expect(await outcome(down)).toEqual([503, 'SERVICE_UNAVAILABLE']);
    expect(await receiptRows(f.id)).toEqual([]);
    storage.faults = {};
  });
});
