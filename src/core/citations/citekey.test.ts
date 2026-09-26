import { describe, expect, it } from 'vitest';
import { baseCiteKey, citeKeyTitleWord, makeCiteKey } from './citekey';

describe('makeCiteKey', () => {
  it('builds lastnameYEARfirstword keys', () => {
    expect(makeCiteKey({ authors: ['Ashish Vaswani', 'Noam Shazeer'], year: 2017, title: 'Attention Is All You Need' })).toBe('vaswani2017attention');
    expect(makeCiteKey({ authors: ['Kurt Gödel'], year: 1931, title: 'Über formal unentscheidbare Sätze' })).toBe('godel1931uber');
    expect(makeCiteKey({ authors: ['van der Waals, Johannes'], year: 1873, title: 'On the Continuity of the Gaseous State' })).toBe('waals1873continuity');
    expect(makeCiteKey({ authors: ['Łukasz Kaiser'], year: 2017, title: 'The {BERT} of $\\alpha$ things' })).toBe('kaiser2017bert');
    expect(makeCiteKey({ authors: ["Conor O'Brien"], year: 2020, title: 'A Study' })).toBe('obrien2020study');
  });

  it('disambiguates with a, b, c… case-insensitively', () => {
    const meta = { authors: ['Ashish Vaswani'], year: 2017, title: 'Attention Is All You Need' };
    expect(makeCiteKey(meta, ['Vaswani2017Attention'])).toBe('vaswani2017attentiona');
    expect(makeCiteKey(meta, new Set(['vaswani2017attention', 'vaswani2017attentiona']))).toBe('vaswani2017attentionb');
    const many = ['k'];
    for (let i = 0; i < 26; i++) many.push('k' + String.fromCharCode(97 + i));
    expect(makeCiteKey({ title: 'k' }, many.map((k) => k.replace(/^k/, 'ref')))).toBe('refaa');
  });

  it('falls back gracefully', () => {
    expect(baseCiteKey({ title: 'The Art of Computer Programming', year: 1968 })).toBe('art1968');
    expect(baseCiteKey({ authors: ['Knuth'] })).toBe('knuth');
    expect(baseCiteKey({ year: 2020 })).toBe('ref2020');
    expect(baseCiteKey({})).toBe('ref');
    expect(citeKeyTitleWord('On the of a')).toBe('');
    expect(citeKeyTitleWord('3D Vision on a Budget')).toBe('3d');
  });
});
