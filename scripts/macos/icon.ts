import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { runStrict } from './codesign.ts';

export const DEFAULT_BRAND_ICON = resolve(import.meta.dir, '../../docs/assets/stitchwire-mark.jpg');

/** Fallback Apple desktop visual grid icon when the brand raster asset is not present. */
export function defaultIconSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1E3A5F"/>
      <stop offset="100%" stop-color="#0F172A"/>
    </linearGradient>
    <linearGradient id="node" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#60A5FA"/>
      <stop offset="100%" stop-color="#2563EB"/>
    </linearGradient>
    <linearGradient id="wire" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#FDE68A"/>
      <stop offset="50%" stop-color="#F59E0B"/>
      <stop offset="100%" stop-color="#FDE68A"/>
    </linearGradient>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.32"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#bg)" filter="url(#shadow)"/>
  <g fill="none" stroke="url(#wire)" stroke-width="32" stroke-linecap="round">
    <path d="M 380 484 C 446 420, 578 548, 644 484"/>
    <path d="M 380 540 C 446 604, 578 476, 644 540"/>
  </g>
  <rect x="210" y="380" width="212" height="264" rx="64" fill="url(#node)"/>
  <rect x="602" y="380" width="212" height="264" rx="64" fill="url(#node)"/>
  <circle cx="382" cy="512" r="24" fill="#0F172A"/>
  <circle cx="642" cy="512" r="24" fill="#0F172A"/>
</svg>`;
}

/** Frame a full-bleed JPEG mark inside the Apple 824x824 squircle grid on a 1024x1024 transparent canvas. */
export function framedJpegIconSvg(jpegPath: string): string {
  const b64 = readFileSync(jpegPath).toString('base64');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <clipPath id="squircle">
      <rect x="100" y="100" width="824" height="824" rx="185"/>
    </clipPath>
    <filter id="shadow" x="-10%" y="-10%" width="120%" height="125%">
      <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#000" flood-opacity="0.22"/>
    </filter>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="#FBF2EC" filter="url(#shadow)"/>
  <image href="data:image/jpeg;base64,${b64}" x="100" y="100" width="824" height="824" preserveAspectRatio="xMidYMid slice" clip-path="url(#squircle)"/>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="none" stroke="#000" stroke-opacity="0.08" stroke-width="4"/>
</svg>`;
}

/** The icon's exact input bytes: the SVG to render (given, default or framed JPEG) or a raster to scale. */
export type IconSource = { format: 'svg' | 'raster'; extension: string; bytes: Buffer };

/** Resolve the brand mascot (or a custom SVG/raster icon) into the bytes the icon is built from. */
export function resolveIconSource(iconPath?: string): IconSource {
  const effective = iconPath ?? (existsSync(DEFAULT_BRAND_ICON) ? DEFAULT_BRAND_ICON : undefined);
  if (effective === undefined)
    return { format: 'svg', extension: '.svg', bytes: Buffer.from(defaultIconSvg()) };
  const extension = extname(effective).toLowerCase();
  if (extension === '.jpg' || extension === '.jpeg') {
    return { format: 'svg', extension: '.svg', bytes: Buffer.from(framedJpegIconSvg(effective)) };
  }
  if (extension === '.svg') return { format: 'svg', extension, bytes: readFileSync(effective) };
  return { format: 'raster', extension, bytes: readFileSync(effective) };
}

/** Generate `AppIcon.icns` in `resourcesDir` from a resolved icon source. */
export function buildIcns(resourcesDir: string, source: IconSource): void {
  const work = mkdtempSync(join(tmpdir(), 'stitchwire-icon-'));
  try {
    const iconset = join(work, 'AppIcon.iconset');
    mkdirSync(iconset);
    const input = join(work, `AppIcon${source.extension}`);
    writeFileSync(input, source.bytes);
    for (const size of [16, 32, 128, 256, 512]) {
      for (const scale of [1, 2]) {
        const px = String(size * scale);
        const name = scale === 1 ? `icon_${size}x${size}.png` : `icon_${size}x${size}@2x.png`;
        const out = join(iconset, name);
        if (source.format === 'raster') {
          runStrict(['sips', '-s', 'format', 'png', '-z', px, px, input, '--out', out], 'sips');
        } else {
          runStrict(['rsvg-convert', '-w', px, '-h', px, input, '-o', out], 'rsvg-convert');
        }
      }
    }
    mkdirSync(resourcesDir, { recursive: true });
    runStrict(['iconutil', '-c', 'icns', iconset, '-o', join(resourcesDir, 'AppIcon.icns')], 'iconutil');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
