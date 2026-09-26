/**
 * Prompt templates for every AI task. Each builder returns a complete AIRequest whose
 * `input`/`hints` also let the offline 'local' provider do the same job heuristically.
 */
import type { AIImage, AIRequest } from './types';

const HANDWRITING_SYSTEM =
  'You transcribe handwritten notes. Output ONLY the transcribed plain text, preserving line breaks. ' +
  'No commentary, no markdown fences, no quotation marks. If a word is illegible, give your best guess.';

const MATH_OCR_SYSTEM =
  'You convert images of mathematics (handwritten or typeset) into LaTeX. Output ONLY the LaTeX source ' +
  'of the expression — no $ or \\[ \\] delimiters, no markdown fences, no explanation. ' +
  'Use standard amsmath commands; use aligned for multi-line derivations.';

export function handwritingRequest(image: AIImage): AIRequest {
  return {
    task: 'handwriting',
    system: HANDWRITING_SYSTEM,
    prompt: 'Transcribe the handwriting in this image as plain text.',
    images: [image],
    temperature: 0,
  };
}

export function mathOcrRequest(image: AIImage): AIRequest {
  return {
    task: 'math-ocr',
    system: MATH_OCR_SYSTEM,
    prompt: 'Convert the mathematics in this image to LaTeX.',
    images: [image],
    temperature: 0,
  };
}

export function summarizeRequest(text: string, sentences = 3): AIRequest {
  return {
    task: 'summarize',
    system: 'You write faithful, concise summaries for a researcher. Never invent facts.',
    prompt: `Summarize the following text in at most ${sentences} sentences. Output only the summary.\n\n"""\n${text}\n"""`,
    input: text,
    hints: { count: sentences },
    temperature: 0.2,
  };
}

export function tagsRequest(text: string, existingTags: string[] = [], count = 5): AIRequest {
  const existing = existingTags.length
    ? `\nExisting tags in the knowledge base (reuse these exact spellings when they fit): ${existingTags.slice(0, 200).join(', ')}\n`
    : '';
  return {
    task: 'tags',
    system: 'You label research notes with concept tags. Respond with JSON only.',
    prompt:
      `Suggest up to ${count} concept tags for the text below. Tags are short concept names ` +
      `(1–3 words, e.g. "reinforcement learning", "Bellman equation"), not sentences or generic words.` +
      existing +
      `\nRespond with a JSON array of strings only, e.g. ["tag one", "tag two"].\n\n"""\n${text}\n"""`,
    input: text,
    hints: { existingTags, count },
    json: true,
    temperature: 0.2,
  };
}

export function clozeRequest(text: string, max = 3): AIRequest {
  return {
    task: 'cloze',
    system: 'You write high-quality spaced-repetition cloze deletions from a researcher\'s own notes. Respond with JSON only.',
    prompt:
      `Create up to ${max} cloze-deletion flashcards from the note below. Each card copies the note ` +
      `(or one self-contained sentence of it) verbatim, wrapping ONE key fact — a term, a definition, a ` +
      `formula or a number — in {{c1::...}}. Keep inline math as $...$. Do not cloze trivial words.\n` +
      `Respond with a JSON array only: [{"text": "... {{c1::answer}} ..."}]\n\n"""\n${text}\n"""`,
    input: text,
    hints: { count: max },
    json: true,
    temperature: 0.3,
  };
}

export function latexRequest(text: string): AIRequest {
  return {
    task: 'latex',
    system:
      'You convert plain-text or unicode mathematics into LaTeX. Output ONLY the LaTeX, without $ delimiters or fences.',
    prompt: `Convert to LaTeX:\n${text}`,
    input: text,
    temperature: 0,
  };
}

/**
 * Plain-text rendering of a request for pasting into a chat UI (subscription bridging).
 * Asks for the answer alone so it can be pasted back verbatim.
 */
export function bridgePromptText(req: AIRequest): string {
  const parts: string[] = [];
  if (req.system) parts.push(req.system);
  parts.push(req.prompt);
  if (req.images?.length) parts.push(`(${req.images.length} image${req.images.length > 1 ? 's' : ''} attached — please paste them into this chat.)`);
  parts.push(
    req.json
      ? 'Reply with the JSON only, in a single code block, so I can copy it back.'
      : 'Reply with the answer only, so I can copy it back verbatim.',
  );
  return parts.join('\n\n');
}
