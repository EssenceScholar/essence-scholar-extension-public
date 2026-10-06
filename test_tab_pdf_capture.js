/**
 * The journal case: a PDF that OPENS instead of downloading.
 *
 * Reported 2026-09-16 — SSRN imports fine because its id is in the url, but a
 * journal PDF reached by clicking "View PDF" opens in a new tab, creates no
 * download, and was invisible to the extension. These are the pure parts of the
 * fix: which urls count as a PDF landing, and whether the capture whitelist
 * still recognises the publisher once the referrer is all that names it.
 *
 *     node test_tab_pdf_capture.js
 */
const fs = require('fs');
const vm = require('vm');

const bg = fs.readFileSync(`${__dirname}/background.js`, 'utf8');
const sources = fs.readFileSync(`${__dirname}/capture-sources.js`, 'utf8');

// Take the regex straight from the shipped source — a test that re-declares it
// would keep passing after the real one drifted.
const m = bg.match(/const _TAB_PDF_RX = new RegExp\(([\s\S]*?)\);\n/);
if (!m) { console.error('FAIL  _TAB_PDF_RX is no longer in background.js'); process.exit(1); }
const ctx = { console };
vm.createContext(ctx);
vm.runInContext(`${sources}\nthis._TAB_PDF_RX = new RegExp(${m[1]});`, ctx);

let fails = 0;
function check(name, cond, detail) {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' — ' + String(detail).slice(0, 160)}`);
  if (!cond) fails++;
}

const OPENS_AS_PDF = [
  ['Wiley pdfdirect',   'https://onlinelibrary.wiley.com/doi/pdfdirect/10.1111/jofi.13245'],
  ['Wiley epdf reader', 'https://onlinelibrary.wiley.com/doi/epdf/10.1111/jofi.13245'],
  ['OUP article-pdf',   'https://academic.oup.com/rfs/article-pdf/36/4/1234/49/hhac123.pdf'],
  ['INFORMS doi/pdf',   'https://pubsonline.informs.org/doi/pdf/10.1287/mnsc.2023.4711'],
  ['Elsevier pdfft',    'https://www.sciencedirect.com/science/article/pii/S0304405X23001234/pdfft?md5=ab&pid=1-s2.0-main.pdf'],
  ['Springer content',  'https://link.springer.com/content/pdf/10.1007/s11142-023-09761-0.pdf'],
  ['arXiv',             'https://arxiv.org/pdf/2401.01234'],
  ['SSRN delivery',     'https://papers.ssrn.com/sol3/Delivery.cfm/SSRN_ID4567890_code1.pdf?abstractid=4567890'],
  ['proxied Wiley',     'https://onlinelibrary-wiley-com.proxy.library.uu.nl/doi/pdf/10.1111/jofi.13245'],
];
const NOT_A_PDF_LANDING = [
  ['the article page',  'https://onlinelibrary.wiley.com/doi/10.1111/jofi.13245'],
  ['an abstract page',  'https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4567890'],
  ['a search results',  'https://www.google.com/search?q=journal+pdf'],
  ['an ordinary page',  'https://example.com/index.html'],
  ['the word pdf',      'https://example.com/about-pdf-files'],
];

console.log('\nwhich urls are a PDF landing');
for (const [label, url] of OPENS_AS_PDF) check(`${label} counts`, ctx._TAB_PDF_RX.test(url), url);
for (const [label, url] of NOT_A_PDF_LANDING) check(`${label} does not`, !ctx._TAB_PDF_RX.test(url), url);

console.log('\nthe whitelist still recognises the publisher');
// A PDF opened in a tab is passed to the gate with the OPENER's url as referrer,
// which is the only thing naming the publisher when the file sits on a CDN.
const cases = [
  ['wiley by url',      { url: 'https://onlinelibrary.wiley.com/doi/pdf/10.1111/x', referrer: '' }, 'wiley'],
  ['oup by url',        { url: 'https://academic.oup.com/rfs/article-pdf/1.pdf', referrer: '' }, 'oup'],
  ['cdn by referrer',   { url: 'https://cdn.example-host.net/files/a1b2.pdf',
                          referrer: 'https://pubsonline.informs.org/doi/10.1287/mnsc.2023.4711' }, 'informs'],
  ['library proxy',     { url: 'https://www-sciencedirect-com.proxy.library.uu.nl/x/pdfft', referrer: '' }, 'elsevier'],
  ['nothing academic',  { url: 'https://example.com/whitepaper.pdf', referrer: 'https://example.com/' }, null],
];
for (const [label, item, expected] of cases) {
  const got = ctx.captureSourceKeyFor(item);
  check(`${label} -> ${expected}`, got === expected, `got ${got}`);
}

console.log('\nthe capture path is wired');
check('a tab PDF goes through the same academic-source gate as a download',
      /_captureOpenedPdf[\s\S]{0,800}_isAcademicSource\(item\)/.test(bg));
check("the reader's global 'off' switch still outranks it",
      /_captureOpenedPdf[\s\S]{0,900}mode === 'off'\) return;/.test(bg));
check('consent for an opened PDF does not look for a download that never existed',
      /record\.openedInTab[\s\S]{0,400}_ingestDownloadItem/.test(bg));
check('the opener tab is remembered, since onUpdated cannot say who opened a tab',
      /chrome\.tabs\.onCreated[\s\S]{0,200}_rememberOpener/.test(bg));
check('bytes are verified to BE a PDF before anything is uploaded',
      /0x25 && bytes\[1\] === 0x50/.test(bg));

console.log('\n' + (fails ? `${fails} FAILED` : 'ALL PASS'));
process.exit(fails ? 1 : 0);
