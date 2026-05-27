import { devices, type ViewportSize } from '@playwright/test';
import type { ViewportName } from './types.js';

export interface ViewportProfile {
  name: ViewportName;
  viewport: ViewportSize;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

/**
 * Build the five preflight viewport profiles. We re-use Playwright's `devices`
 * descriptors where they exist so the viewport matches a real-world device
 * (DPR, touch, UA) rather than just a width.
 *
 * mobile-320 is a custom profile — no Playwright descriptor maps exactly,
 * and small-screen breakpoint coverage matters for responsive design.
 */
export function buildViewportProfiles(): Record<ViewportName, ViewportProfile> {
  const iPhone13 = devices['iPhone 13'];
  const iPadGen7 = devices['iPad (gen 7)'];

  if (!iPhone13 || !iPadGen7) {
    throw new Error(
      'preflight: Playwright `devices` is missing iPhone 13 or iPad (gen 7). ' +
        'Upgrade @playwright/test to >=1.50.0.'
    );
  }

  return {
    'mobile-320': {
      name: 'mobile-320',
      viewport: { width: 320, height: 568 },
      deviceScaleFactor: 2,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    },
    'mobile-375': {
      name: 'mobile-375',
      viewport: iPhone13.viewport,
      deviceScaleFactor: iPhone13.deviceScaleFactor,
      isMobile: iPhone13.isMobile,
      hasTouch: iPhone13.hasTouch,
      userAgent: iPhone13.userAgent,
    },
    'tablet-768': {
      name: 'tablet-768',
      viewport: iPadGen7.viewport,
      deviceScaleFactor: iPadGen7.deviceScaleFactor,
      isMobile: iPadGen7.isMobile,
      hasTouch: iPadGen7.hasTouch,
      userAgent: iPadGen7.userAgent,
    },
    'desktop-1280': {
      name: 'desktop-1280',
      viewport: { width: 1280, height: 800 },
    },
    'desktop-1920': {
      name: 'desktop-1920',
      viewport: { width: 1920, height: 1080 },
    },
  };
}

export const ALL_VIEWPORTS: ViewportName[] = [
  'mobile-320',
  'mobile-375',
  'tablet-768',
  'desktop-1280',
  'desktop-1920',
];
