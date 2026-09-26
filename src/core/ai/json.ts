/**
 * Robust JSON extraction from model output: handles ```json fences, leading prose,
 * trailing commentary, smart quotes and trailing commas.
 */

function tryParse(s: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    // common model slips: trailing commas, smart quotes
    const repaired = s
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/,\s*([}\]])/g, '$1');
    if (repaired === s) return { ok: false };
    try {
      return { ok: true, value: JSON.parse(repaired) };
    } catch {
      return { ok: false };
    }
  }
}

/** Finds the balanced JSON value starting at `start` (an opening brace/bracket), string-aware. */
function balancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}

/**
 * Extracts the first JSON value from model output.
 * @throws SyntaxError when no parseable JSON is found.
 */
export function extractJSON(text: string): unknown {
  const trimmed = text.trim();
  const direct = tryParse(trimmed);
  if (direct.ok) return direct.value;

  const fenceRe = /```(?:json|JSON)?\s*\n?([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(trimmed))) {
    const r = tryParse(m[1].trim());
    if (r.ok) return r.value;
  }

  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (c !== '{' && c !== '[') continue;
    const end = balancedEnd(trimmed, i);
    if (end < 0) continue;
    const r = tryParse(trimmed.slice(i, end + 1));
    if (r.ok) return r.value;
  }
  throw new SyntaxError('No JSON found in model output');
}
