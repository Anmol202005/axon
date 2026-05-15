// Monochrome dark theme.
//
// Accent = `bold` with no `color` prop, so emphasis comes from weight and
// inherits the user's terminal foreground (renders bright on every theme).
// Hue is reserved for semantics: red = error, yellow = warning.

export const Theme = {
  muted: "gray",
  border: "gray",
  warn: "yellow",
  error: "red",
} as const;
