import { describe, expect, it } from 'vitest';
import {
  clozeIndices,
  clozeItemsToCards,
  flashcardSourceHash,
  generateCards,
  generateCardsAI,
  hasFlashcardTag,
  heuristicCloze,
  parseClozeItems,
  parseClozes,
  renderCloze,
  splitClozes,
  stripFlashcardTag,
  type ClozeAI,
} from './cloze';

const src = (text: string, type: 'text' | 'math' | 'ink' = 'text') => ({ type, text, pageTitle: 'Thermodynamics' });

describe('tag handling', () => {
  it('detects and strips #flashcard', () => {
    expect(hasFlashcardTag('Entropy #flashcard')).toBe(true);
    expect(hasFlashcardTag('#flashcards at start')).toBe(true);
    expect(hasFlashcardTag('line one\n#flashcard')).toBe(true);
    expect(hasFlashcardTag('#flashcardx')).toBe(false);
    expect(hasFlashcardTag('email#flashcard')).toBe(false);
    expect(stripFlashcardTag('Entropy is disorder #flashcard')).toBe('Entropy is disorder');
    expect(stripFlashcardTag('#flashcard Entropy  is disorder')).toBe('Entropy is disorder');
    expect(stripFlashcardTag('a #flashcard b')).toBe('a b');
  });
});

describe('parseClozes', () => {
  it('parses answers, hints and indices', () => {
    const s = parseClozes('The {{c1::mitochondria}} is the {{c2::powerhouse::metaphor}} of the {{c1::cell}}');
    expect(s.map((x) => [x.index, x.answer, x.hint])).toEqual([
      [1, 'mitochondria', undefined],
      [2, 'powerhouse', 'metaphor'],
      [1, 'cell', undefined],
    ]);
    expect(clozeIndices('{{c3::a}} {{c1::b}} {{c3::c}}')).toEqual([1, 3]);
  });

  it('is brace-aware for LaTeX answers', () => {
    const s = parseClozes('Root: {{c1::$\\sqrt{\\frac{a}{b}}$}} done');
    expect(s).toHaveLength(1);
    expect(s[0].answer).toBe('$\\sqrt{\\frac{a}{b}}$');
    expect(parseClozes('{{c1::$a::b$}}')[0].answer).toBe('$a::b$');
  });
});

describe('renderCloze', () => {
  const front = 'The {{c1::mitochondria}} is the {{c2::powerhouse::metaphor}} #flashcard';
  it('hides the active cloze and shows others as plain text', () => {
    const q = renderCloze(front, 1, false);
    expect(q).toContain('[...]');
    expect(q).toContain('powerhouse');
    expect(q).not.toContain('mitochondria');
    expect(q).not.toContain('#flashcard');
  });
  it('shows hints and reveals answers highlighted', () => {
    expect(renderCloze(front, 2, false)).toContain('[metaphor]');
    const a = renderCloze(front, 1, true);
    expect(a).toContain('<mark class="cloze cloze-revealed">mitochondria</mark>');
  });
  it('supports custom formats', () => {
    expect(renderCloze('A {{c1::b}}', 1, false, { hidden: () => '___', revealed: (x) => `*${x}*` })).toBe('A ___');
  });
});

describe('heuristic cloze generation', () => {
  it('clozes bold terms first', () => {
    const out = heuristicCloze('The **Carnot cycle** is the most efficient heat engine cycle.')!;
    expect(out).toContain('**{{c1::Carnot cycle}}**');
  });

  it('clozes definitions ("X is Y")', () => {
    const out = heuristicCloze('Entropy is a measure of disorder in a system.')!;
    expect(parseClozes(out)[0].answer).toBe('Entropy');
  });

  it('clozes links, math and key numbers; caps at 3', () => {
    const out = heuristicCloze('See [[Boltzmann constant]]: $k_B = 1.380649 \\times 10^{-23}$ J/K, measured in 2019 with 99% accuracy.')!;
    const answers = parseClozes(out).map((s) => s.answer);
    expect(answers).toContain('Boltzmann constant');
    expect(answers.some((a) => a.startsWith('$k_B'))).toBe(true);
    expect(answers.length).toBeLessThanOrEqual(3);
    // numbers inside math are never clozed separately
    expect(answers).not.toContain('1.380649');
  });

  it('skips pronoun subjects, list numbering and code', () => {
    expect(heuristicCloze('It is fine.')).toBeNull();
    const out = heuristicCloze('1. use `x = 42` here');
    expect(out).toBeNull();
  });

  it('is deterministic', () => {
    const t = 'The **Krebs cycle** produces 2 ATP and happens in the [[mitochondria]].';
    expect(heuristicCloze(t)).toBe(heuristicCloze(t));
  });

  it('splits multi-cloze text into single-cloze items', () => {
    expect(splitClozes('{{c1::a}} and {{c2::b}}')).toEqual(['{{c1::a}} and b', 'a and {{c1::b}}']);
  });
});

describe('generateCards', () => {
  it('respects explicit clozes (one card per index), never AI', async () => {
    const cards = generateCards(src('{{c1::Heat}} flows from {{c2::hot}} to cold {{c1::bodies}} #flashcard'));
    expect(cards.map((c) => c.clozeIndex)).toEqual([1, 2]);
    expect(cards.every((c) => c.kind === 'cloze' && !c.front.includes('#flashcard'))).toBe(true);
    const ai: ClozeAI = { completeJSON: () => Promise.reject(new Error('should not be called')) };
    expect(await generateCardsAI(src('{{c1::x}} y'), ai)).toHaveLength(1);
  });

  it('turns "question :: answer" into a basic card', () => {
    const [c] = generateCards(src('What is the first law? :: Energy is conserved #flashcard'));
    expect(c).toMatchObject({ kind: 'basic', front: 'What is the first law?', back: 'Energy is conserved', clozeIndex: 0 });
  });

  it('non-text blocks become basic cards with context', () => {
    const [c] = generateCards({ type: 'math', text: 'dS = \\frac{\\delta Q}{T}', pageTitle: 'Entropy', contextText: 'Clausius definition:' });
    expect(c.kind).toBe('basic');
    expect(c.front).toContain('Recall:');
    expect(c.front).toContain('Entropy');
    expect(c.front).toContain('Clausius definition:');
    expect(c.back).toBe('$$\ndS = \\frac{\\delta Q}{T}\n$$');
    const [ink] = generateCards(src('', 'ink'));
    expect(ink).toMatchObject({ kind: 'basic', clozeIndex: 0 });
  });

  it('falls back to a basic card when nothing can be clozed', () => {
    const [c] = generateCards(src('remember this #flashcard'));
    expect(c.kind).toBe('basic');
    expect(c.back).toBe('remember this');
  });

  it('hash changes with content, and with page title only for non-text blocks', () => {
    expect(flashcardSourceHash(src('a'))).not.toBe(flashcardSourceHash(src('b')));
    expect(flashcardSourceHash(src('a'))).toBe(flashcardSourceHash({ ...src('a'), pageTitle: 'Other' }));
    expect(flashcardSourceHash(src('a', 'math'))).not.toBe(flashcardSourceHash({ ...src('a', 'math'), pageTitle: 'Other' }));
  });
});

describe('AI cloze generation', () => {
  const text = 'Entropy is a measure of disorder, introduced by Clausius in 1865.';
  const aiReturning = (value: unknown): ClozeAI => ({
    async completeJSON(_req, validate) {
      const v = validate(value);
      if (v === undefined) throw new Error('invalid');
      return { value: v, provider: 'gemini' };
    },
  });

  it('validates items and renumbers them into one card each', async () => {
    const cards = await generateCardsAI(
      src(text),
      aiReturning([
        { text: '{{c1::Entropy}} is a measure of disorder.' },
        { text: 'Entropy was introduced by {{c1::Clausius}} in {{c1::1865}}.' },
        { text: 'no cloze here' },
        { text: '{{c1::Invented}} answer.' },
      ]),
    );
    expect(cards.map((c) => c.clozeIndex)).toEqual([1, 2]);
    expect(cards[1].front).toBe('Entropy was introduced by {{c2::Clausius}} in {{c2::1865}}.');
  });

  it('falls back to heuristics on invalid output or errors', async () => {
    const heuristic = generateCards(src(text));
    expect(await generateCardsAI(src(text), aiReturning({ nope: true }))).toEqual(heuristic);
    const failing: ClozeAI = { completeJSON: () => Promise.reject(new Error('offline')) };
    expect(await generateCardsAI(src(text), failing)).toEqual(heuristic);
  });

  it('parseClozeItems accepts strings and {cards: [...]} wrappers', () => {
    expect(parseClozeItems(['{{c1::Entropy}} is'], text)).toEqual(['{{c1::Entropy}} is']);
    expect(parseClozeItems({ cards: [{ text: '{{c1::Clausius}}' }] }, text)).toEqual(['{{c1::Clausius}}']);
    expect(parseClozeItems([], text)).toBeUndefined();
    expect(clozeItemsToCards(['{{c1::a}}', '{{c1::b}}'])[1]).toEqual({ kind: 'cloze', front: '{{c2::b}}', clozeIndex: 2 });
  });
});

describe('definition predicates', () => {
  it('clozes a substantial predicate when the subject is a pronoun', () => {
    const out = heuristicCloze('It is the ratio between heat flow and temperature.');
    expect(out && parseClozes(out)[0].answer).toBe('the ratio between heat flow and temperature');
  });
});
