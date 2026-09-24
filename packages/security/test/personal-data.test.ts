import { describe, expect, it } from 'vitest';
import { isPersonalKey, MASK, maskPersonalData, maskPersonalText } from '../src/index.js';

describe('personal-data masking (docs/systems/ask.md)', () => {
  it('masks values under personal keys and keeps the rest', () => {
    const rows = [{ id: 7, customer_name: 'Amina B.', email: 'amina@example.com', phone: '+212 612 345 678', city: 'Casablanca', total: 1299.5, created_at: '2026-09-24T10:00:00Z' }];
    expect(maskPersonalData(rows)).toEqual([{ id: 7, customer_name: MASK, email: MASK, phone: MASK, city: 'Casablanca', total: 1299.5, created_at: '2026-09-24T10:00:00Z' }]);
  });

  it('finds emails and phone numbers in free text and nested values', () => {
    expect(maskPersonalText('Call +212 612-345-678 or write to omar.k@shop.ma today')).toBe(`Call ${MASK} or write to ${MASK} today`);
    expect(maskPersonalData({ note: { text: 'reach me at 0612345678' } })).toEqual({ note: { text: `reach me at ${MASK}` } });
  });

  it('leaves ids, amounts, dates and timestamps alone', () => {
    expect(maskPersonalText('order 20260924183512 total 1299.50 on 2026-09-24, sku 50U8000FUXMV')).toBe('order 20260924183512 total 1299.50 on 2026-09-24, sku 50U8000FUXMV');
    expect(maskPersonalData({ id: 123456789012, name_of_shop: 'Digitronics' })).toEqual({ id: 123456789012, name_of_shop: 'Digitronics' });
  });

  it('recognises personal keys in common spellings', () => {
    for (const k of ['email', 'customer_email', 'E-mail', 'phone_number', 'mobile', 'first_name', 'lastName'.replace('N', '_n'), 'address', 'shipping_address', 'iban', 'national_id', 'name']) expect(isPersonalKey(k), k).toBe(true);
    for (const k of ['id', 'total', 'city', 'status', 'created_at', 'shop_name', 'product_name', 'hotel']) expect(isPersonalKey(k), k).toBe(false);
  });
});
