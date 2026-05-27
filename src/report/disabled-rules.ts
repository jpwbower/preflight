import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PreflightAxeDisabled } from '../types.js';

/**
 * Render the loud "disabled axe rules" banner into the run output directory.
 *
 * This serves two purposes:
 *  1. Reviewers reading the HTML report see the disabled rules + reasons
 *     at the top, not buried inside the per-test detail panes.
 *  2. The `.preflight/last-run/disabled-axe-rules.md` file is a stable
 *     filesystem artefact so future tooling (CI, PR comments) can pick
 *     it up without scraping HTML.
 */
export async function writeDisabledRulesArtefact(
  outDir: string,
  disabled: PreflightAxeDisabled[]
): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const target = path.join(outDir, 'disabled-axe-rules.md');
  await writeFile(target, renderDisabledRulesMarkdown(disabled), 'utf8');
  return target;
}

export function renderDisabledRulesMarkdown(disabled: PreflightAxeDisabled[]): string {
  const banner = '# Disabled axe rules\n\n';
  if (disabled.length === 0) {
    return `${banner}_No axe rules are disabled in this run._\n`;
  }
  const rows = disabled
    .map((d) => `- **${d.rule}** — ${d.reason}`)
    .join('\n');
  return [
    banner,
    'These axe rules have been suppressed in `preflight.config.ts`. Each',
    'suppression has a reason attached. preflight surfaces this list',
    'loudly on purpose: silently disabling rules is the most common way',
    'an a11y scan turns into compliance theatre.',
    '',
    rows,
    '',
  ].join('\n');
}

export function renderDisabledRulesHtmlHeader(disabled: PreflightAxeDisabled[]): string {
  if (disabled.length === 0) return '';
  const items = disabled
    .map(
      (d) =>
        `<li><code>${escapeHtml(d.rule)}</code> &mdash; ${escapeHtml(d.reason)}</li>`
    )
    .join('');
  return [
    '<div style="background:#ffe9a8;border:2px solid #b07c00;padding:1em;margin:1em 0;font-family:sans-serif;">',
    '<h2 style="margin-top:0;">Disabled axe rules in this run</h2>',
    '<p>These accessibility rules have been suppressed in <code>preflight.config.ts</code>.',
    'preflight surfaces them on every report so they cannot silently hide. ',
    'If you do not recognise a suppression below, treat it as a regression and re-enable.</p>',
    `<ul>${items}</ul>`,
    '</div>',
  ].join('');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
