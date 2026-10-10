/**
 * "Clay & Marigold": the palette of a terracotta gullak and a marigold coin.
 * Warm cream surfaces, cocoa text, terracotta for primary actions, marigold
 * for highlights, leaf green for money arriving.
 */

const colors = {
  light: {
    // Legacy aliases (kept for backward compatibility)
    text: '#2B1D14',
    tint: '#C2562F',

    // Core surfaces
    background: '#FBF4EA',
    foreground: '#2B1D14',

    // Cards / elevated surfaces
    card: '#FFFCF7',
    cardForeground: '#2B1D14',

    // Primary action color (buttons, links, active states)
    primary: '#C2562F',
    primaryForeground: '#FFF8F0',

    // Secondary / less-emphasis interactive surfaces
    secondary: '#F3E5D3',
    secondaryForeground: '#2B1D14',

    // Muted / subdued elements (dividers, timestamps, placeholders)
    muted: '#EFE2D0',
    mutedForeground: '#7A6656',

    // Accent highlights (badges, selected items, focus rings)
    accent: '#F2A33A',
    accentForeground: '#2B1D14',

    // Destructive actions (delete, error states)
    destructive: '#B3261E',
    destructiveForeground: '#FFFFFF',

    // Money arriving / settled
    success: '#2F7D4F',
    successSoft: '#E3F0E6',

    // Warnings (sponsor paused, testnet notices)
    warningSoft: '#FCEBCB',

    // Balance card
    clay: '#A9471F',
    clayDeep: '#7E3215',

    // Borders and input outlines
    border: '#E8D8C3',
    input: '#E3D1BA',
  },

  // Border radius (in px) for cards, buttons, inputs, and modals.
  radius: 18,
};

export default colors;
