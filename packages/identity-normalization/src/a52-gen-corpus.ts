// SPEC: A.5.2
/**
 * a52-gen-corpus.ts — cross-language property-test corpus generator (Wave A, WA-06).
 *
 * Deterministically (seeded PRNG — reproducible failures) generates 12k+ mixed identifiers:
 * unicode emails (NFC/NFD variants, case bombs, gmail dots/plus, exotic whitespace padding),
 * IN + GCC phone formats (national, trunk-0, +CC, 00CC, bare-CC, spaced/dashed/dotted,
 * extensions, Arabic-Indic digits), and pure garbage — then computes the TS-side
 * normalized value + BOTH AMD-01 hash spaces (interop plain sha256, internal per-brand
 * salted) for every row and writes JSONL.
 *
 * db/iceberg/spark/_identity_normalization_xlang_test.py re-derives every field from `raw`
 * with the Python twin and diffs byte-for-byte. Required result: 0 mismatches (A.5.2).
 *
 * CLI:  pnpm --filter @brain/identity-normalization exec tsx src/a52-gen-corpus.ts <out.jsonl>
 */

import { writeFileSync } from 'node:fs';
import {
  normalizeEmail,
  normalizePhone,
  interopHash,
  internalHash,
  BRAND_DEFAULT_COUNTRIES,
  type BrandDefaultCountry,
} from './index.js';

// ── Seeded PRNG (mulberry32) — deterministic corpus, reproducible failures ───
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0xa52_06; // A.5.2 / WA-06
const rnd = mulberry32(SEED);
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const int = (min: number, max: number): number => min + Math.floor(rnd() * (max - min + 1));
const digits = (n: number): string => Array.from({ length: n }, () => int(0, 9)).join('');
const maybe = (p: number): boolean => rnd() < p;

// ── Email material ────────────────────────────────────────────────────────────
const EMAIL_LOCALS = [
  'user', 'first.last', 'first.middle.last', 'user+tag', 'user+tag+more', 'u.s.e.r+promo',
  'Ünïcode', 'ÅSTRÖM', 'δοκιμή', 'ΟΔΟΣ', 'испытание', '테스트', 'ｆｕｌｌｗｉｄｔｈ',
  'İstanbul', 'straße', 'STRASSE', 'café', 'café', // NFC vs NFD précomposed
  'éclair', 'éclair', 'ﬁrst', '🦄unicorn', 'öko', 'ösgür',
  'name123', '123name', 'a', 'x_y-z',
] as const;
const EMAIL_DOMAINS = [
  'gmail.com', 'GMAIL.COM', 'GMail.Com', 'yahoo.co.in', 'hotmail.com', 'example.com',
  'ExÄmple.com', 'exämple.com', '例え.jp', 'شركة.ae', 'domain.ae', 'brand.sa',
  'sub.domain.qa', 'x.co',
] as const;
const PADDING = ['', '', '', ' ', '  ', '\t', '\n', ' ', '﻿', '　', ' ', '   '] as const;
const EMAIL_GARBAGE = [
  '', ' ', '   ', ' ﻿', 'no-at-sign', '@', 'a@', '@b', '@@', 'a@@b',
  'spaces in local@x.com', '💥💥💥', 'null', 'undefined', '​', 'a@b', 'ثبثب',
] as const;

function genEmailRaw(): string {
  if (maybe(0.12)) return pick(EMAIL_GARBAGE);
  let local = pick(EMAIL_LOCALS);
  let domain = pick(EMAIL_DOMAINS);
  let email = `${local}@${domain}`;
  // Random case bombing (exercises toLowerCase vs str.lower equivalence)
  if (maybe(0.35)) {
    email = email
      .split('')
      .map((c) => (maybe(0.5) ? c.toUpperCase() : c))
      .join('');
  }
  // Random NFD explosion of the whole string (exercises NFC round-trip)
  if (maybe(0.25)) email = email.normalize('NFD');
  return `${pick(PADDING)}${email}${pick(PADDING)}`;
}

// ── Phone material (IN + GCC mobile shapes) ───────────────────────────────────
// National significant numbers around each market's mobile plan; INTENTIONALLY includes
// borderline digits — the property is "both libphonenumber ports agree", not "is valid".
function genNationalNumber(country: BrandDefaultCountry): string {
  switch (country) {
    case 'IN': return `${int(6, 9)}${digits(9)}`;          // 10d mobile 6–9xxxxxxxxx
    case 'AE': return `5${pick(['0', '2', '4', '5', '6', '8'])}${digits(7)}`; // 9d 05x
    case 'SA': return `5${int(0, 9)}${digits(7)}`;         // 9d 05x
    case 'QA': return `${pick(['3', '5', '6', '7'])}${digits(7)}`; // 8d
    case 'BH': return `3${int(2, 9)}${digits(6)}`;         // 8d 3x
    case 'KW': return `${pick(['5', '6', '9'])}${digits(7)}`; // 8d
    case 'OM': return `${pick(['7', '9'])}${digits(7)}`;   // 8d
  }
}
const CC: Record<BrandDefaultCountry, string> = {
  IN: '91', AE: '971', SA: '966', QA: '974', BH: '973', KW: '965', OM: '968',
};
const PHONE_GARBAGE = [
  '', ' ', '+', '++', '12', '999', 'not a phone', 'call me maybe', '+abc', '00', '0',
  `+${'9'.repeat(20)}`, digits(4), digits(25), '+91', 'ext 123', '(-)', '​​',
] as const;

function toArabicIndic(s: string, extended: boolean): string {
  const base = extended ? 0x06f0 : 0x0660; // ۰..۹ vs ٠..٩
  return s.replace(/[0-9]/g, (d) => String.fromCodePoint(base + Number(d)));
}

function genPhoneRaw(country: BrandDefaultCountry): string {
  if (maybe(0.14)) return pick(PHONE_GARBAGE);
  const nsn = genNationalNumber(country);
  const cc = CC[country];
  let raw: string;
  switch (int(0, 7)) {
    case 0: raw = nsn; break;                                  // bare national
    case 1: raw = `0${nsn}`; break;                            // trunk-0 (valid IN/AE/SA; probes others)
    case 2: raw = `+${cc}${nsn}`; break;                       // E.164
    case 3: raw = `00${cc}${nsn}`; break;                      // 00 international prefix
    case 4: raw = `${cc}${nsn}`; break;                        // CC without '+'
    case 5: {                                                  // spaced/dashed/dotted/parens
      const sep = pick([' ', '-', '.', ' - ']);
      const body = `${nsn.slice(0, 5)}${sep}${nsn.slice(5)}`;
      raw = pick([`+${cc} ${body}`, `(0) ${body}`, body, `(${cc}) ${body}`]);
      break;
    }
    case 6: raw = `+${cc}${nsn} ext. ${int(1, 999)}`; break;   // extension (dropped by E.164)
    default: raw = toArabicIndic(`+${cc}${nsn}`, maybe(0.5)); break; // Arabic-Indic digits
  }
  return `${pick(PADDING)}${raw}${pick(PADDING)}`;
}

// ── Noise (random unicode, assigned a random kind) ────────────────────────────
// UNICODE-STABILITY BOUNDARY (found by running this test INSIDE apache/spark:3.5.3):
// the Spark image runs Python 3.8 (unicodedata = Unicode 12.1) while Node's ICU is ~15.x.
// Codepoints ASSIGNED AFTER Unicode 12.1 (e.g. new combining marks in the U+08D0 area)
// get different NFC/casing across the two runtimes — an irreducible runtime property, not
// a twin bug. The equivalence contract is therefore over the character repertoire stable
// in BOTH runtimes; noise draws only from blocks fully assigned for a decade+.
const STABLE_NOISE_BLOCKS: ReadonlyArray<readonly [number, number]> = [
  [0x00a0, 0x024f], // Latin-1 + Extended-A/B
  [0x0391, 0x03c9], // Greek core (incl final sigma casing)
  [0x0400, 0x04ff], // Cyrillic
  [0x0900, 0x097f], // Devanagari
  [0x4e00, 0x4fff], // CJK slice
];
function genNoise(): string {
  const len = int(0, 24);
  let s = '';
  for (let i = 0; i < len; i += 1) {
    const r = rnd();
    if (r < 0.4) s += String.fromCodePoint(int(0x20, 0x7e));
    else if (r < 0.7) {
      const [lo, hi] = pick(STABLE_NOISE_BLOCKS);
      s += String.fromCodePoint(int(lo, hi));
    } else if (r < 0.9) s += String.fromCodePoint(int(0x1f300, 0x1f5ff)); // emoji (Unicode 6/7)
    else s += pick(['́', '̈', '﻿', '‍', '@', '+', '9']);
  }
  return s;
}

// ── Row assembly: TS-side normalized + both AMD-01 hash spaces ────────────────
const SALTS = ['a'.repeat(64), 'f00d'.repeat(16)] as const; // fixed 64-hex salts (golden-vector convention)

export interface CorpusRow {
  i: number;
  kind: 'email' | 'phone';
  raw: string;
  country: BrandDefaultCountry | null;
  salt: string;
  normalized: string | null;
  interop: string | null;
  internal: string | null;
}

export function generateCorpus(count = 12000): CorpusRow[] {
  const rows: CorpusRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const r = rnd();
    let kind: 'email' | 'phone';
    let raw: string;
    let country: BrandDefaultCountry | null = null;
    if (r < 0.4) {
      kind = 'email';
      raw = genEmailRaw();
    } else if (r < 0.92) {
      kind = 'phone';
      country = pick(BRAND_DEFAULT_COUNTRIES);
      raw = genPhoneRaw(country);
    } else {
      kind = maybe(0.5) ? 'email' : 'phone';
      raw = genNoise();
      if (kind === 'phone') country = pick(BRAND_DEFAULT_COUNTRIES);
    }
    const salt = pick(SALTS);
    const normalized = kind === 'email' ? normalizeEmail(raw) : normalizePhone(raw, country!);
    rows.push({
      i,
      kind,
      raw,
      country,
      salt,
      normalized,
      interop: normalized === null ? null : interopHash(normalized),
      internal: normalized === null ? null : internalHash(normalized, salt),
    });
  }
  return rows;
}

export function corpusJsonl(count = 12000): string {
  return generateCorpus(count).map((row) => JSON.stringify(row)).join('\n') + '\n';
}

// ── CLI ───────────────────────────────────────────────────────────────────────
const invokedAsScript = process.argv[1]?.endsWith('a52-gen-corpus.ts');
if (invokedAsScript) {
  const out = process.argv[2];
  if (!out) {
    console.error('usage: tsx src/a52-gen-corpus.ts <out.jsonl>');
    process.exit(2);
  }
  const jsonl = corpusJsonl();
  writeFileSync(out, jsonl, 'utf8');
  console.log(`[a52-gen-corpus] wrote ${jsonl.split('\n').length - 1} rows -> ${out}`);
}
