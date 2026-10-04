// Generates the fictional demo papers used in the video (real PDFs with a text layer, typeset
// with KaTeX and printed by Chromium).   node video/assets/papers.mjs  → video/build/papers/*.pdf
import { chromium } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import katex from 'katex';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'build', 'papers');
mkdirSync(out, { recursive: true });
const katexCss = readFileSync(join(here, '..', '..', 'node_modules', 'katex', 'dist', 'katex.min.css'), 'utf8').replace(
  /url\(fonts\//g,
  `url(file://${join(here, '..', '..', 'node_modules', 'katex', 'dist', 'fonts')}/`,
);
const m = (tex, display = false) => katex.renderToString(tex, { displayMode: display, output: 'html' });

const css = `
  @page { size: Letter; margin: 0.75in 0.7in; }
  body { font: 10pt/1.38 'Liberation Serif', 'Times New Roman', serif; color: #111; margin: 0; }
  h1 { font-size: 17pt; text-align: center; margin: 0 0 8pt; line-height: 1.2; }
  .authors { text-align: center; font-size: 10.5pt; } .aff { text-align: center; font-style: italic; font-size: 9pt; margin-bottom: 14pt; }
  .cols { column-count: 2; column-gap: 0.28in; text-align: justify; hyphens: auto; }
  h2 { font-size: 11pt; margin: 10pt 0 4pt; } h3 { font-size: 10pt; margin: 8pt 0 3pt; font-style: italic; }
  p { margin: 0 0 5pt; text-indent: 1em; } .abstract { font-size: 9pt; margin: 0 0 8pt; } .abstract p { text-indent: 0; }
  .eq { margin: 6pt 0; position: relative; } .eq .no { position: absolute; right: 0; top: 50%; transform: translateY(-50%); font-size: 9.5pt; }
  .katex-display { margin: 0 !important; }
  figure { margin: 8pt 0; text-align: center; font-size: 8.5pt; } figure svg { width: 100%; }
`;

const papers = [
  {
    file: 'variance-reduction.pdf',
    title: 'Variance Reduction for Policy Gradients with Learned State Baselines',
    authors: 'Maya Okafor, Lin Chen, Samir Haddad',
    aff: 'Department of Computer Science, Northbridge University · 2026',
    abstract:
      'Policy gradient methods optimise a parameterised policy directly, but their Monte Carlo gradient estimates are notoriously noisy. We revisit the classical result that subtracting a state-dependent baseline leaves the estimator unbiased while reducing its variance, derive the variance-optimal baseline for a single parameter, and show that a learned value function recovers most of the benefit in practice. Across twelve continuous-control tasks, learned baselines cut gradient variance by 4.1× on average and halve the number of environment steps needed to reach expert return.',
    body: `
      <h2>1 Introduction</h2>
      <p>Reinforcement learning agents improve by trial and error: they act, observe a reward, and adjust their behaviour. Policy gradient methods make this adjustment explicit by following the gradient of expected return with respect to the policy parameters. Their appeal is generality: they handle continuous actions, stochastic policies and partial observability without modification.</p>
      <p>The price of that generality is variance. A single trajectory carries little information about the gradient, and naive estimators can require millions of samples. This paper studies the simplest and most widely used remedy, the baseline, and asks how much of its theoretical benefit survives when the baseline itself must be learned.</p>
      <h2>2 Background</h2>
      <p>We consider a Markov decision process with discount factor ${m('\\gamma \\in [0,1)')} and a stochastic policy ${m('\\pi_\\theta(a \\mid s)')}. The objective is the expected discounted return ${m('J(\\theta)')}. The policy gradient theorem expresses its gradient as an expectation over trajectories:</p>
      <div class="eq">${m('\\nabla_\\theta J(\\theta) = \\mathbb{E}_{\\pi_\\theta}\\Big[\\sum_{t=0}^{T} \\nabla_\\theta \\log \\pi_\\theta(a_t \\mid s_t)\\, G_t\\Big]', true)}<span class="no">(1)</span></div>
      <p>where ${m('G_t = \\sum_{k \\ge t} \\gamma^{k-t} r_k')} is the return from step ${m('t')}. REINFORCE replaces the expectation with a sample average, which is unbiased but noisy.</p>
      <h3>2.1 Baselines</h3>
      <p>Because the score function has zero mean, any function of the state can be subtracted from the return without introducing bias. With a baseline ${m('b(s_t)')} the estimator becomes</p>
      <div class="eq">${m('\\hat g = \\frac{1}{N}\\sum_{i=1}^{N}\\sum_{t=0}^{T} \\nabla_\\theta \\log \\pi_\\theta(a_t^i \\mid s_t^i)\\,\\big(G_t^i - b(s_t^i)\\big)', true)}<span class="no">(2)</span></div>
      <p>The variance-optimal constant baseline weights returns by the squared norm of the score; a learned value function ${m('V_\\phi(s) \\approx \\mathbb{E}[G_t \\mid s_t = s]')} is a close and practical approximation.</p>
      <h2>3 Method</h2>
      <p>We fit ${m('V_\\phi')} by regression on observed returns, interleaving one critic update with every policy update. The policy step uses the advantage ${m('A_t = G_t - V_\\phi(s_t)')}, normalised per batch. The critic minimises</p>
      <div class="eq">${m('\\mathcal{L}(\\phi) = \\tfrac{1}{2}\\,\\mathbb{E}\\big[(G_t - V_\\phi(s_t))^2\\big]', true)}<span class="no">(3)</span></div>
      <p>Both networks share no parameters, which we found more stable than a shared torso with two heads.</p>
      <h2>4 Experiments</h2>
      <p>We evaluate on twelve continuous-control tasks with five seeds each. Learned baselines reduce the empirical variance of ${m('\\hat g')} by a factor of 4.1 on average and reach expert return in roughly half the environment steps of vanilla REINFORCE. Gains are largest on long-horizon tasks, where returns vary most between states.</p>
      <h2>5 Conclusion</h2>
      <p>A learned state baseline is a small change with a large effect: it keeps the estimator unbiased, removes most of its variance, and costs one extra regression per update.</p>`,
  },
  {
    file: 'contrastive-manipulation.pdf',
    title: 'Contrastive Representation Learning for Robotic Manipulation from Few Demonstrations',
    authors: 'Elena Varga, Tomás Ruiz, Priya Natarajan',
    aff: 'Institute for Embodied Intelligence · 2024',
    abstract:
      'Robots that learn manipulation skills from a handful of demonstrations need visual representations that capture what matters for control. We pre-train an image encoder with a contrastive objective on unlabelled interaction videos, then fine-tune a behaviour-cloning policy on ten demonstrations per task. The contrastive representation improves success rates on six real-world grasping and insertion tasks from 41% to 78%, and transfers across camera viewpoints without retraining.',
    body: `
      <h2>1 Introduction</h2>
      <p>Imitation learning lets a robot acquire a skill by watching a person perform it, but policies trained from raw pixels need far more demonstrations than people are willing to provide. Self-supervised representation learning offers a way out: learn what the scene contains from cheap, unlabelled data, and spend demonstrations only on how to act.</p>
      <h2>2 Method</h2>
      <p>Our encoder is trained with the InfoNCE objective, pulling together embeddings of frames from the same interaction and pushing apart frames from different ones:</p>
      <div class="eq">${m('\\mathcal{L}_{\\text{NCE}} = -\\log \\frac{\\exp(z_i^\\top z_j / \\tau)}{\\sum_{k \\ne i} \\exp(z_i^\\top z_k / \\tau)}', true)}<span class="no">(1)</span></div>
      <p>The behaviour-cloning policy maps the frozen embedding to end-effector actions and is trained on ten demonstrations per task.</p>
      <h2>3 Results</h2>
      <p>On six grasping and insertion tasks, success rises from 41% with an ImageNet encoder to 78% with the contrastive encoder, and the representation transfers to new camera viewpoints without retraining.</p>`,
  },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (const p of papers) {
  await page.setContent(
    `<!doctype html><meta charset="utf-8"><title>${p.title}</title><style>${katexCss}${css}</style>
     <h1>${p.title}</h1><div class="authors">${p.authors}</div><div class="aff">${p.aff}</div>
     <div class="cols"><div class="abstract"><b>Abstract.</b> <p>${p.abstract}</p></div>${p.body}</div>`,
    { waitUntil: 'load' },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: join(out, p.file), format: 'Letter', printBackground: true, preferCSSPageSize: true, tagged: true });
  console.log('wrote', p.file);
}
await browser.close();
