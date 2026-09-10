// Single source of truth for the download-capture whitelist.
// Loaded by background.js (importScripts) AND onboarding.html (<script>), so the
// settings checkboxes and the actual gate can never drift apart.
//
// `pattern` is matched (case-insensitive) against BOTH the download url and its
// referrer. Publisher patterns accept '.' OR '-' between host words because a
// library proxy rewrites www.sciencedirect.com to www-sciencedirect-com.proxy…;
// the same PDF must be captured on both routes.
// (referrer note) — journal PDFs often arrive from a CDN with only the referrer naming
// the publisher. All sources are enabled by default; the user can untick any in
// the extension settings (stored as {download_capture_sources: {key: false}}).
const CAPTURE_SOURCES = [
  { key: 'ssrn',          label: 'SSRN',                         pattern: 'ssrn\\.com|Delivery\\.cfm', unstableServerFetch: true },
  // unstableServerFetch, added 2026-09-10: NBER caps how many PDFs one reader may
  // download. A server-side fetch either trips that cap or spends it invisibly, so
  // the popup steers the reader to download it themselves and imports the file.
  { key: 'nber',          label: 'NBER',                         pattern: 'nber\\.org', unstableServerFetch: true },
  { key: 'arxiv',         label: 'arXiv',                        pattern: 'arxiv\\.org' },
  { key: 'repec',         label: 'RePEc / EconPapers / EconStor', pattern: 'repec\\.org|econpapers|econstor' },
  { key: 'elsevier',      label: 'ScienceDirect (Elsevier)',     pattern: 'sciencedirect[.-]com' },
  { key: 'springer',      label: 'Springer',                     pattern: 'springer[.-]com|link[.-]springer' },
  { key: 'wiley',         label: 'Wiley',                        pattern: 'wiley[.-]com|onlinelibrary[.-]wiley' },
  { key: 'tandf',         label: 'Taylor & Francis',             pattern: 'tandfonline[.-]com' },
  { key: 'oup',           label: 'Oxford University Press',      pattern: 'academic[.-]oup[.-]com' },
  { key: 'uchicago',      label: 'University of Chicago Press',  pattern: 'journals[.-]uchicago[.-]edu' },
  { key: 'informs',       label: 'INFORMS',                      pattern: 'pubsonline[.-]informs[.-]org' },
  { key: 'jstor',         label: 'JSTOR',                        pattern: 'jstor[.-]org', unstableServerFetch: true },
  { key: 'cambridge',     label: 'Cambridge University Press',   pattern: 'cambridge[.-]org' },
  { key: 'aea',           label: 'American Economic Association', pattern: 'aeaweb[.-]org' },
  // Library routes (Settings → Connected access): LibKey resolves a DOI to the
  // entitled PDF; an EZproxy login URL carries the publisher link after ?url=.
  { key: 'library',       label: 'Your library (LibKey / proxy links)', pattern: 'libkey\\.io|ezproxy|[./-]proxy[.-]|/login\\?url=' },
];

// Pure: which whitelist entry (if any) does this download belong to?
function captureSourceKeyFor(item) {
  const haystack = `${item.url || ''} ${item.referrer || ''}`;
  for (const s of CAPTURE_SOURCES) {
    if (new RegExp(s.pattern, 'i').test(haystack)) return s.key;
  }
  return null;
}

// Pure: does this PAGE belong to a source where server-side PDF fetching is
// known-unstable (Cloudflare walls, single-use links, login walls)? For these,
// the popup steers the user to download locally — the capture flow then offers
// the import from the file on disk, which always works.
function unstableSourceFor(url) {
  for (const s of CAPTURE_SOURCES) {
    if (s.unstableServerFetch && new RegExp(s.pattern, 'i').test(url || '')) return s;
  }
  return null;
}
