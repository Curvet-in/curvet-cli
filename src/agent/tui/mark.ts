/**
 * The Curvet mark, at the size a terminal can render it.
 *
 * Generated once from public/Curvet_logo.png rather than decoded at runtime:
 * shipping a PNG and a decoder to draw one fixed picture would be weight on
 * every install for something that never changes. Half-block characters give
 * two vertical pixels per cell, which is what makes the curve read as a curve
 * rather than a staircase.
 */
export const CURVET_MARK: string[] = [
  "  ▀▄▄ █▄ ▄▄▄▄▄",
  "    ▀█████▄▄▀▀█▄",
  "     ████████▄ ██▄",
  " ▄▀ ▄██████▀██▄ ██",
  "▄█ ▄████▀  ▄███ ██▄",
  "██▄ ▀▀▀    ███▀ ██▀",
  "▀██▄▄▄   ▄███▀ ███",
  "  ███▄▄████▀ ▄███",
  "   ▀▀██▀▀▀▄▄███▀",
  "       ▀▀▀▀▀▀",
];

/** Widest line, so a caller can centre it or decide it will not fit. */
export const MARK_WIDTH = Math.max(...CURVET_MARK.map((l) => l.length));
