# Appearance and grouped settings

Open Global Settings, then choose a category and a settings page. Back returns
one level; All settings returns to the category overview. Closing and reopening
settings starts at the overview.

- Appearance & display: style customization, interface language, status markers.
- Notifications & sound: browser question notifications and completion sounds.
- Account & extensions: account and limits, apps and plugins.
- History & session: archived conversations and browser sign-out.

Style customization offers system/light/dark theme, accent color, text selection
color, and standard/high contrast. Changes apply immediately. The default uses
high contrast and blue highlighting. Selected text uses whichever of black or
white provides greater contrast against the chosen highlight color. A preview
shows text selection and selected controls. Restore appearance defaults resets
these colors, contrast, and the theme (system), without changing status markers.

Appearance preferences are stored in localStorage under `codex-web.appearance.v1`;
the existing theme preference remains under `codex-daemon-web-theme`. Settings
apply to this browser profile and origin, not to all devices. Invalid stored
values fall back to defaults, and unavailable storage does not prevent editing
preferences during the current session. Browser push subscriptions retain their existing server-side behavior.

Validation: `pnpm check`, `pnpm exec tsx --test tests/appearance.test.ts`,
and `pnpm exec vite build`. The appearance tests cover malformed/blocked storage
and minimum 4.5:1 selection contrast across 4,096 representative colors.
