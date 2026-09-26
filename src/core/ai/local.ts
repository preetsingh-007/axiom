/**
 * The 'local' provider: deterministic, offline heuristics. Always available, instant,
 * private — and the router's last-resort fallback for the tasks it supports.
 */
import type { AIProvider, AIRequest, AITask } from './types';
import { AIUnavailableError } from './errors';
import { heuristicCloze, splitClozes, stripFlashcardTag } from '../srs/cloze';

// ---------------------------------------------------------------- text utilities

const STOPWORDS = new Set(
  (
    'a about above after again against all also am an and any are as at be because been before being below between ' +
    'both but by can could did do does doing down during each either else etc few for from further had has have having ' +
    'he her here hers herself him himself his how however i if in into is it its itself just let may me might more most ' +
    'much must my myself no nor not now of off on once one only or other our ours ourselves out over own per rather ' +
    'same shall she should since so some such than that the their theirs them themselves then there these they this ' +
    'those through thus to too under until up upon us use used using very via was we well were what when where whether ' +
    'which while who whom whose why will with within without would yet you your yours yourself yourselves ' +
    'e.g i.e new like get got make made many first second two three given see thing things way ways'
  ).split(/\s+/),
);

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

function words(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).map((w) => w.replace(/['’]s$/, ''));
}

/** Strips markdown/LaTeX noise so heuristics see prose. */
function prose(text: string): string {
  return stripFlashcardTag(text)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\$[^$\n]+\$/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a)
    .replace(/[*_~>#]+/g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/** Sentence split that keeps abbreviations like "e.g." and decimals intact. */
export function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“(\[])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

// ---------------------------------------------------------------- summarize

/**
 * Extractive summary: sentences scored by normalised term frequency of their content words,
 * with a small bonus for early position; the top `n` are returned in document order.
 */
export function summarizeText(text: string, n = 3): string {
  const sentences = splitSentences(prose(text));
  if (sentences.length <= n) return sentences.join(' ');
  const tf = new Map<string, number>();
  for (const w of words(sentences.join(' '))) if (!STOPWORDS.has(w) && w.length > 2) tf.set(w, (tf.get(w) ?? 0) + 1);
  const max = Math.max(1, ...tf.values());
  const scored = sentences.map((s, i) => {
    const ws = words(s).filter((w) => !STOPWORDS.has(w) && w.length > 2);
    const score = ws.length ? ws.reduce((acc, w) => acc + (tf.get(w) ?? 0) / max, 0) / Math.sqrt(ws.length) : 0;
    const position = i === 0 ? 0.25 : i < 3 ? 0.1 : 0;
    return { i, score: score + position };
  });
  const top = [...scored].sort((a, b) => b.score - a.score || a.i - b.i).slice(0, n);
  return top
    .sort((a, b) => a.i - b.i)
    .map((t) => sentences[t.i])
    .join(' ');
}

// ---------------------------------------------------------------- keyphrases

/**
 * Keyphrase extraction (RAKE): candidate phrases are runs of content words between stopwords
 * and punctuation; word score = degree / frequency; phrase score = sum of word scores.
 * Explicit [[links]] and #tags in the text, and existing vault tags that occur in it, rank first.
 */
export function extractKeyphrases(text: string, n = 5, existingTags: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const k = t.trim().toLowerCase();
    if (!k || seen.has(k) || out.length >= n) return;
    seen.add(k);
    out.push(t.trim());
  };
  const raw = stripFlashcardTag(text);
  for (const m of raw.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) add(m[1]);
  for (const m of raw.matchAll(/(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu)) add(m[1].replace(/[-_]/g, ' '));

  const clean = prose(raw);
  const lower = ` ${words(clean).join(' ')} `;
  for (const tag of existingTags) {
    const k = words(tag).join(' ');
    if (k && lower.includes(` ${k} `)) add(tag);
  }

  // candidate n-grams (1–3 words) inside runs of content words between stopwords/punctuation
  const counts = new Map<string, number>();
  const wordFreq = new Map<string, number>();
  for (const chunk of clean.split(/[.,;:!?()[\]{}"“”\n—–]|\s-\s/)) {
    let run: string[] = [];
    const flush = () => {
      for (let i = 0; i < run.length; i++) {
        for (let len = 1; len <= 3 && i + len <= run.length; len++) {
          const g = run.slice(i, i + len).join(' ');
          counts.set(g, (counts.get(g) ?? 0) + 1);
        }
      }
      run = [];
    };
    for (const w of words(chunk)) {
      if (STOPWORDS.has(w) || /^\d+$/.test(w) || w.length < 2) flush();
      else {
        run.push(w);
        wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
    }
    flush();
  }
  // repeated phrases rank first; multi-word phrases beat their parts; short single words rank last
  const ranked = [...counts].map(([g, c]) => {
    const ws = g.split(' ');
    const meanFreq = ws.reduce((acc, w) => acc + (wordFreq.get(w) ?? 0), 0) / ws.length;
    return { g, score: c * (1 + 0.6 * (ws.length - 1)) + 0.3 * meanFreq - (ws.length === 1 && g.length < 5 ? 1 : 0) };
  });
  ranked.sort((a, b) => b.score - a.score || b.g.length - a.g.length || a.g.localeCompare(b.g));
  // skip phrases sharing a word with a better one ("learning studies agents" after "reinforcement learning")
  const used = new Set(out.flatMap((t) => words(t)));
  for (const { g } of ranked) {
    const ws = g.split(' ');
    if (ws.some((w) => used.has(w))) continue;
    for (const w of ws) used.add(w);
    add(g);
  }
  return out;
}

// ---------------------------------------------------------------- unicode → LaTeX

const SYMBOLS: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\epsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi',
  ο: 'o', π: '\\pi', ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau',
  υ: '\\upsilon', φ: '\\phi', ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega',
  Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi', Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon',
  Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega',
  '∑': '\\sum', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint', '∏': '\\prod', '∐': '\\coprod',
  '∞': '\\infty', '≤': '\\leq', '≥': '\\geq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '≅': '\\cong',
  '∼': '\\sim', '≃': '\\simeq', '∝': '\\propto', '≪': '\\ll', '≫': '\\gg',
  '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset', '⊃': '\\supset', '⊆': '\\subseteq', '⊇': '\\supseteq',
  '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset', '∖': '\\setminus',
  '→': '\\to', '←': '\\leftarrow', '↔': '\\leftrightarrow', '↦': '\\mapsto', '⇒': '\\Rightarrow',
  '⇐': '\\Leftarrow', '⇔': '\\Leftrightarrow', '⟹': '\\implies', '⟸': '\\impliedby', '⟺': '\\iff',
  '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists', '¬': '\\neg', '∧': '\\land', '∨': '\\lor',
  '∂': '\\partial', '∇': '\\nabla', '×': '\\times', '·': '\\cdot', '⋅': '\\cdot', '÷': '\\div', '±': '\\pm',
  '∓': '\\mp', '∘': '\\circ', '⊗': '\\otimes', '⊕': '\\oplus', '†': '\\dagger', '⊥': '\\perp', '∥': '\\parallel',
  '∠': '\\angle', '°': '^\\circ', '′': "'", '″': "''", '…': '\\ldots', '⋯': '\\cdots', 'ℝ': '\\mathbb{R}',
  'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}', 'ℓ': '\\ell', 'ℏ': '\\hbar',
  '⟨': '\\langle', '⟩': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil',
  '½': '\\frac{1}{2}', '⅓': '\\frac{1}{3}', '⅔': '\\frac{2}{3}', '¼': '\\frac{1}{4}', '¾': '\\frac{3}{4}',
};

const SUPERSCRIPTS: Record<string, string> = {
  '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9',
  '⁺': '+', '⁻': '-', '⁼': '=', '⁽': '(', '⁾': ')', ⁿ: 'n', ⁱ: 'i', ᵀ: 'T', ᵏ: 'k', ˣ: 'x', ʸ: 'y',
};
const SUBSCRIPTS: Record<string, string> = {
  '₀': '0', '₁': '1', '₂': '2', '₃': '3', '₄': '4', '₅': '5', '₆': '6', '₇': '7', '₈': '8', '₉': '9',
  '₊': '+', '₋': '-', '₌': '=', '₍': '(', '₎': ')', ₐ: 'a', ₑ: 'e', ₒ: 'o', ₓ: 'x', ᵢ: 'i', ⱼ: 'j', ₖ: 'k',
  ₙ: 'n', ₘ: 'm', ₜ: 't', ₚ: 'p', ₛ: 's',
};

const FUNCTIONS = 'arcsin|arccos|arctan|sinh|cosh|tanh|sin|cos|tan|cot|sec|csc|log|ln|exp|lim|max|min|sup|inf|det|arg|gcd';

const group = (s: string) => (s.length === 1 ? s : `{${s}}`);

/**
 * Converts unicode / plain-text math to LaTeX: Greek letters, operators and relations,
 * super/subscript characters (x² → x^2, aᵢⱼ → a_{ij}), √ and ∛, named functions and
 * simple fractions (a/b, (x+1)/(x-1) → \frac{…}{…}).
 */
export function unicodeToLatex(input: string): string {
  let out = '';
  const chars = [...input.normalize('NFC')];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (c in SUPERSCRIPTS || c in SUBSCRIPTS) {
      const table = c in SUPERSCRIPTS ? SUPERSCRIPTS : SUBSCRIPTS;
      let run = '';
      while (i < chars.length && chars[i] in table) run += table[chars[i++]];
      i--;
      out += (table === SUPERSCRIPTS ? '^' : '_') + group(run);
    } else if (c === '√' || c === '∛' || c === '∜') {
      const root = c === '√' ? '\\sqrt' : c === '∛' ? '\\sqrt[3]' : '\\sqrt[4]';
      let j = i + 1;
      let arg = '';
      if (chars[j] === '(') {
        let depth = 0;
        for (; j < chars.length; j++) {
          if (chars[j] === '(') depth++;
          else if (chars[j] === ')' && --depth === 0) break;
          arg += chars[j];
        }
        arg = arg.slice(1);
      } else {
        while (j < chars.length && /[\p{L}\p{N}.]/u.test(chars[j])) arg += chars[j++];
        j--;
      }
      out += `${root}{${unicodeToLatex(arg)}}`;
      i = j;
    } else if (c in SYMBOLS) {
      const cmd = SYMBOLS[c];
      out += cmd;
      // a command followed by a letter needs a separating space: \alpha x, not \alphax
      if (/[a-zA-Z]$/.test(cmd) && cmd.startsWith('\\') && /[a-zA-Z]/.test(chars[i + 1] ?? '')) out += ' ';
    } else out += c;
  }
  out = out
    .replace(new RegExp(`(?<![\\\\a-zA-Z])(${FUNCTIONS})(?![a-zA-Z])`, 'g'), '\\$1')
    // x^(a+b) → x^{a+b}, x^-1 → x^{-1}, x^10 → x^{10}
    .replace(/([\^_])\(((?:[^()]|\([^()]*\))*)\)/g, '$1{$2}')
    .replace(/([\^_])(-?\d{2,}|-[A-Za-z0-9])/g, '$1{$2}');
  return fractions(out);
}

/** a/b → \frac{a}{b} for simple operands (tokens, commands, or parenthesised groups). */
function fractions(s: string): string {
  const script = String.raw`(?:[\^_](?:\{[^{}]*\}|[A-Za-z0-9]))*`;
  const operand = String.raw`(\\partial\s*[A-Za-z0-9]+${script}|(?:\\[A-Za-z]+)?\((?:[^()]|\([^()]*\))*\)${script}|\\?[A-Za-z0-9.]+${script})`;
  const re = new RegExp(`${operand}\\s*/\\s*${operand}`, 'g');
  const unwrap = (x: string) => (x.startsWith('(') && x.endsWith(')') ? x.slice(1, -1) : x);
  let prev = '';
  while (prev !== s) {
    prev = s;
    s = s.replace(re, (_, a: string, b: string) => `\\frac{${unwrap(a)}}{${unwrap(b)}}`);
  }
  return s;
}

// ---------------------------------------------------------------- provider

const LOCAL_TASKS = new Set<AITask>(['summarize', 'tags', 'cloze', 'latex']);

/** Offline heuristics for summarize / tags / cloze / latex. Output formats match the prompts. */
export class LocalProvider implements AIProvider {
  readonly id = 'local' as const;
  readonly label = 'On-device heuristics';
  readonly supportsImages = false;

  isConfigured(): boolean {
    return true;
  }

  supportsTask(task: AITask): boolean {
    return LOCAL_TASKS.has(task);
  }

  async complete(req: AIRequest): Promise<string> {
    const input = req.input ?? req.prompt;
    const count = req.hints?.count;
    switch (req.task) {
      case 'summarize':
        return summarizeText(input, count ?? 3);
      case 'tags':
        return JSON.stringify(extractKeyphrases(input, count ?? 5, req.hints?.existingTags));
      case 'cloze': {
        const text = stripFlashcardTag(input);
        const cloze = heuristicCloze(text, count ?? 3);
        return JSON.stringify(cloze ? splitClozes(cloze).map((t) => ({ text: t })) : []);
      }
      case 'latex':
        return unicodeToLatex(input);
      default:
        throw new AIUnavailableError(
          req.task === 'handwriting' || req.task === 'math-ocr'
            ? `Recognising ${req.task === 'handwriting' ? 'handwriting' : 'math'} needs an AI provider (add a free Gemini key or enable on-device AI in Settings → AI)`
            : `The offline engine cannot do "${req.task}"`,
          req.task,
          'local',
        );
    }
  }
}
