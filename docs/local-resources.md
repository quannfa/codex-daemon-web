# Local resource previews

The WebUI reads original files on its own host as its existing operating-system
user. Nginx only proxies HTTP requests. No resource copies, symlink trees,
permission changes, or public sharing links are created. The registry next to
the access-token file contains only resource IDs and original paths. It persists across service restarts.

Use ordinary Markdown in conversations:

```markdown
![Chart](/absolute/project/results/chart.png)
[Report](/absolute/project/results/report.md)
[File with spaces](</absolute/project/results/my report.pdf>)
```

Local images render inline. Links open a preview with original-file and download
actions. Markdown files render with tables and nested file links; relative paths
resolve against the document directory. Conversation-relative paths resolve
against the conversation working directory. UTF-8 paths, escaped paths,
`file://` URLs, and trailing `:line:column` references are accepted. Links inside
code fences remain code. Arbitrary raw HTML in conversation Markdown is not run.

PNG/JPEG/GIF/WebP/AVIF, PDF, Markdown, sanitized SVG, and text files have previews.
HTML has a sanitized, sandboxed static preview; scripts, external files, and
interactive HTML bundles are not supported in this phase. SVG active content is
removed. Office/binary files have a download action. Text/SVG/HTML previews are
bounded at 5 MB; image/PDF/download requests stream original bytes and support
HEAD and single HTTP byte ranges, without the old 2.5 MB whole-file limit.

Every registration and file request requires a valid WebUI session. Registration
also requires an allowed browser Origin. Any ordinary local file readable by the
WebUI operating-system account can be registered; files do not have to belong to
the current conversation or a Codex project. No daemon project lookup is needed.
The former `CODEX_WEB_RESOURCE_ROOTS` setting is no longer used.

Known credential/config locations, .env files, private-key file types, the WebUI
state directory, /proc, /sys, /dev, and non-regular files remain excluded. This is
not a general secret-content scanner. Symlinks to ordinary readable files are
allowed; resolved targets and open descriptors are rechecked so symlinks cannot
bypass sensitive-file exclusions. OS read permissions remain unchanged. Existing
registry entries and their resource IDs remain valid when upgrading from the old
project-scoped registry; only metadata is retained, not copies of file content.

Endpoints use the existing authenticated API namespace:

- `POST /api/resources`: register `{path, threadId?}` or a relative file
  reference with `{path, baseResourceId}`. Stores metadata only.
- `GET|HEAD /api/resources/<id>/<filename>`: authenticated original bytes;
  add `?download=1` for an attachment. The filename is cosmetic; IDs resolve paths.

The UI works both at `/codex/` and at `/`. Resource URLs always use the root
`/api/resources` namespace, matching the existing session cookie Path=/api.
Nginx already forwards this namespace to the WebUI; no cookie scope expansion
or extra file-system access for nginx is needed. Resource
IDs are identifiers, not access tokens. Original files may change, disappear,
or become unreadable; the UI reports errors and does not silently restore a copy.
Remote daemon paths and files on other mcptun machines are not interpreted as
local resources. Multi-host forwarding and immutable snapshots are future work.

Validation: `pnpm check`; `pnpm exec tsx --test tests/resources.test.ts`.
Tests cover Unicode/path parsing, active URL rejection, authentication, origin,
outside-project access, sensitive-target symlink replacement, OS permissions, ranges, HEAD, conditional
requests, registry restart, and original-file updates/deletion. Browser checks
cover inline images, sanitized SVG, nested Markdown/images, PDF ranges, HTML
isolation, a 6 MB download, preview bounds, and mobile layout.

## Mathematical formulas

Both conversation Markdown and document previews support `$...$`, `$$...$$`,
`\(...\)`, and `\[...\]` through remark-math and KaTeX. The LaTeX bracket
forms are normalized before Markdown parsing while fenced/inline/indented code
is preserved. Invalid/incomplete formulas remain readable; untrusted KaTeX
commands are disabled. Display equations scroll horizontally on narrow screens.
The stylesheet and font assets are served locally, without an external CDN.

Validation: `pnpm exec tsx --test tests/math-markdown.test.ts tests/resources.test.ts`.
