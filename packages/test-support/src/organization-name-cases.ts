/** The owner-approved #122 corpus, shared by every organization-name input test. */
type Case = { label: string; input: string } & ({ value: string; reason?: never } | { reason: string; value?: never })
const accept = (input: string, value = input, label = input): Case => ({ label, input, value })
const reject = (label: string, input: string, reason: string): Case => ({ label, input, reason })
export const organizationNameCases: Case[] = [
  ...['Úklid Novák s.r.o.', 'Čistota & syn, a.s.', "O'Brien Services", 'O’Brien Services',
    'Acme (CZ) – Praha 4', 'Firma #1 / pobočka Brno', '50% Clean!', 'acme.example', 'Seznam.example a.s.',
    'info@example.com', '<Acme> "Clean"', 'Café 🧽', '清洁公司'].map(value => accept(value)),
  accept('  Acme  ', 'Acme', 'trim'),
  accept('  Cafe\u0301  ', 'Café', 'trim then NFC'),
  accept('Acme  Inc', 'Acme  Inc', 'ordinary internal spaces'),
  accept('🧽'.repeat(200), '🧽'.repeat(200), '200 code points, 400 UTF-16 units'),
  accept('e\u0301'.repeat(200), 'é'.repeat(200), 'length after NFC'),
  reject('empty', '', 'empty'), reject('blank', '   ', 'empty'),
  reject('201 code points', 'x'.repeat(201), 'too_long'),
  reject('201 supplementary code points', '🧽'.repeat(201), 'too_long'),
  ...[0, 5, 9, 10, 13, 31, 127, 128, 133, 159].map(cp => reject(`Cc U+${cp.toString(16)}`, `Acme${String.fromCodePoint(cp)}Inc`, 'control_character')),
  ...[0x2028, 0x2029].map(cp => reject(`separator U+${cp.toString(16)}`, `Acme${String.fromCodePoint(cp)}Inc`, 'line_separator')),
  ...[0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0xad, 0x200e, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069].map(cp => reject(`Cf U+${cp.toString(16)}`, `Acme${String.fromCodePoint(cp)}Inc`, 'hidden_character')),
  // Boundaries and whitespace-only values must retain their forbidden category.
  ...[
    ...[0, 9, 10, 11, 12, 13, 0x85].map(cp => [cp, 'control_character'] as const),
    ...[0x2028, 0x2029].map(cp => [cp, 'line_separator'] as const),
    [0xfeff, 'hidden_character'] as const,
    ...[0xa0, 0x1680, ...Array.from({ length: 11 }, (_, i) => 0x2000 + i), 0x202f, 0x205f, 0x3000].map(cp => [cp, 'nonstandard_space'] as const),
    ...[0x378, 0xe000, 0xd800, 0xdc00].map(cp => [cp, 'invalid_character'] as const),
  ].flatMap(([cp, reason]) => {
    const char = String.fromCodePoint(cp)
    return [
      reject(`leading U+${cp.toString(16)}`, ` ${char}Acme `, reason),
      reject(`trailing U+${cp.toString(16)}`, ` Acme${char} `, reason),
      reject(`only U+${cp.toString(16)}`, ` ${char} `, reason),
    ]
  }),
  reject('table ZWSP', 'Ac\u200bme', 'hidden_character'),
  reject('table trailing NEL', 'Acme\u0085', 'control_character'),
  reject('leading bidi override', '\u202eemca', 'hidden_character'),
  reject('ZWJ emoji', 'Team 👩\u200d👩\u200d👧', 'hidden_character'),
  ...[0xa0, 0x2000, 0x200a, 0x202f, 0x205f, 0x3000].map(cp => reject(`Zs U+${cp.toString(16)}`, `Acme${String.fromCodePoint(cp)}Inc`, 'nonstandard_space')),
  ...[0x378, 0xe000, 0xf0000, 0xd800, 0xdc00].map(cp => reject(`Cn/Co/Cs U+${cp.toString(16)}`, `Acme${String.fromCodePoint(cp)}Inc`, 'invalid_character')),
  ...['https://acme.example', 'Acme see HTTP://x.example/invitations/accept?token=1', 'ftp://acme.test', 'Acme custom+v1.2-x://host.test'].map(value => reject(value, value, 'url_not_allowed')),
]

/** Raw JSON/schema inputs; text forms cannot submit these values. */
export const organizationNameTypeCases: { label: string; input: unknown; reason: 'required' | 'not_string'; value?: never }[] = [
  { label: 'missing name', input: undefined, reason: 'required' },
  ...[null, 123, false, {}, []].map(input => ({ label: `non-string ${JSON.stringify(input)}`, input, reason: 'not_string' as const })),
]
