
// Prevent multiple script injections
if (window.ssrnSummarizerInitialized) {
  console.log('Essence Scholar already initialized, skipping...');
  // Exit early to prevent re-execution
  throw new Error('Essence Scholar already initialized');
}

// Mark as initialized immediately to prevent race conditions
window.ssrnSummarizerInitialized = true;

// Create a connection to the background service worker
var port = window.ssrnSummarizerPort = window.ssrnSummarizerPort || null;

// Keep track of the current state
let currentState = {
  isInitialized: false,
  content: null
};

// Initialize the content script
function initialize() {
  // Prevent multiple initializations
  if (currentState.isInitialized) {
    console.log('Content script already initialized, skipping...');
    return;
  }
  
  // Double-check window flag to prevent race conditions
  if (window.ssrnSummarizerInitialized && window.ssrnSummarizerInitialized !== true) {
    console.log('Content script initialization already in progress, skipping...');
    return;
  }
  
  console.log('Content script initialized');
  currentState.isInitialized = true;
  
  // Create port connection only if not already connected
  if (!port) {
    try {
      port = chrome.runtime.connect({ name: 'content-script' });
      
      // Notify that we're ready
      port.postMessage({
        action: 'contentScriptReady',
        url: window.location.href
      });
      
      // If this is a PDF page, notify the background script
      isPDFPage().then(result => {
        const isPDF = typeof result === 'boolean' ? result : result.isPDF;
        if (isPDF) {
          console.log('PDF page detected, notifying background script');
          port.postMessage({
            action: 'pdfDetected',
            url: window.location.href
          });
        }
      }).catch(error => {
        console.error('Error checking PDF status:', error);
      });
    } catch (error) {
      console.error('Error creating port connection:', error);
    }
  }
}

// Check if current page is a PDF - Content-based detection (not URL-based)
async function isPDFPage() {
  console.log('Starting PDF content detection...');
  
  // Primary method: Check document content type
  const isApplicationPdf = document.contentType === 'application/pdf';
  console.log('  Document contentType:', document.contentType, '-> PDF:', isApplicationPdf);
  
  // Secondary method: Check for PDF viewer elements in the DOM
  const pdfViewerElements = [
    // Chrome's built-in PDF viewer
    'embed[type="application/pdf"]',
    'object[type="application/pdf"]',
    'object[data*=".pdf"]',
    // Modern Chrome PDF viewer
    'embed#plugin',
    'embed[src*=".pdf"]',
    // Firefox PDF.js viewer
    '#viewer',
    '#viewerContainer', 
    '.page[data-page-number]',
    '#pageContainer1',
    // Generic PDF viewer indicators
    '[class*="pdf-viewer"]',
    '[id*="pdf-viewer"]',
    '[class*="pdfViewer"]',
    '[id*="pdfViewer"]',
    // Canvas elements used by PDF.js
    'canvas[data-main-rotation]',
    '.canvasWrapper canvas',
    // PDF.js specific elements
    '#outerContainer',
    '#mainContainer',
    '.toolbar',
    '#toolbarContainer',
    // Check for PDF.js in iframe
    'iframe[src*="pdfjs"]',
    'iframe[src*="pdf.js"]',
    // Modern browser viewers
    'div[class*="pdf"]',
    'div[id*="pdf"]',
    // Edge PDF viewer
    'div[role="application"][aria-label*="PDF"]'
  ];
  
  let hasPdfElements = false;
  let foundElements = [];
  
  for (const selector of pdfViewerElements) {
    const element = document.querySelector(selector);
    if (element) {
      hasPdfElements = true;
      foundElements.push(selector);
    }
  }
  
  console.log('  PDF viewer elements found:', foundElements);
  
  // Tertiary method: Check for PDF.js global variables
  const hasPdfJsGlobals = !!(window.PDFViewerApplication || 
                           window.PDFJS || 
                           window.pdfjsLib ||
                           window.PDFWorker);
  console.log('  PDF.js globals detected:', hasPdfJsGlobals);
  
  // Quaternary method: Check document body content patterns
  const bodyClassList = document.body ? document.body.className : '';
  const bodyHasPdfClass = bodyClassList.includes('pdf') || bodyClassList.includes('PDF');
  console.log('  Body has PDF class:', bodyHasPdfClass);
  
  // Quinary method: Check for canvas elements with PDF-like dimensions
  const canvases = document.querySelectorAll('canvas');
  let hasPdfLikeCanvas = false;
  if (canvases.length > 0) {
    // PDF pages typically have aspect ratios around 0.7-0.8 (A4 = 0.707)
    for (const canvas of canvases) {
      const aspectRatio = canvas.height / canvas.width;
      if (aspectRatio > 0.6 && aspectRatio < 1.5 && canvas.width > 200 && canvas.height > 200) {
        hasPdfLikeCanvas = true;
        break;
      }
    }
  }
  console.log('  Has PDF-like canvas:', hasPdfLikeCanvas, `(${canvases.length} canvas elements)`);
  
  // Senary method: Check meta tags and headers
  const metaContentType = document.querySelector('meta[http-equiv="content-type"]');
  const metaHasPdf = metaContentType && metaContentType.content.includes('application/pdf');
  console.log('  Meta content-type has PDF:', metaHasPdf);
  
    // Categorize the source of the PDF
  const url = window.location.href.toLowerCase();
  
  // Define PDF source categories
  const isSSRN = url.includes('ssrn.com');
  const isLocalFile = window.location.protocol === 'file:';
  const isPublisherSite = url.includes('wiley.com') || 
                         url.includes('sciencedirect.com') ||
                         url.includes('springer.com') ||
                         url.includes('tandfonline.com') ||
                         url.includes('jstor.org') ||
                         url.includes('academic.oup.com');

  // Helper function to verify PDF content is accessible
  async function verifyPdfAccess() {
    try {
      // Try to read a small part of the PDF
      const response = await fetch(window.location.href, {
        method: 'HEAD',  // Just check headers first
        credentials: 'include'
      });
      
      if (!response.ok) {
        console.log('  PDF access check failed:', response.status);
        return false;
      }

      const contentType = response.headers.get('content-type');
      if (!contentType || !contentType.includes('pdf')) {
        console.log('  Content type check failed:', contentType);
        return false;
      }

      return true;
    } catch (error) {
      console.log('  PDF access verification failed:', error);
      return false;
    }
  }

  // For SSRN, be permissive but verify access
  if (isSSRN) {
    const hasViewer = isApplicationPdf || 
                     document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    const canAccess = await verifyPdfAccess();
    console.log('  SSRN PDF check:', { hasViewer, canAccess });
    return { isPDF: hasViewer && canAccess, source: 'ssrn', canAccess };
  }

  // For local files, be lenient - just check basic indicators
  if (isLocalFile) {
    // For local files, any of these is good enough
    const isPDF = isApplicationPdf || 
                 hasPdfElements ||
                 hasPdfJsGlobals ||
                 url.toLowerCase().endsWith('.pdf');
    
    console.log('  Local file PDF check:', {
      isApplicationPdf,
      hasPdfElements,
      hasPdfJsGlobals,
      hasCorrectExtension: url.toLowerCase().endsWith('.pdf')
    });
    
    return { isPDF, source: 'local', canAccess: true };
  }

  // For publisher sites, be very strict and verify access
  if (isPublisherSite) {
    const hasViewer = isApplicationPdf && 
                     document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]');
    const canAccess = await verifyPdfAccess();
    console.log('  Publisher site strict check:', { hasViewer, canAccess });
    return { isPDF: hasViewer && canAccess, source: 'publisher', canAccess };
  }

  // For other sites (including browser PDF viewers), be more permissive
  const hasViewer = isApplicationPdf || 
                   hasPdfElements || 
                   hasPdfJsGlobals ||
                   hasPdfLikeCanvas;
                   
  let canAccess = true; // Default to accessible for browser viewers
  
  // Only verify access for remote PDFs
  if (window.location.protocol === 'https:' || window.location.protocol === 'http:') {
    try {
      canAccess = await verifyPdfAccess();
    } catch (error) {
      console.log('  Access verification failed, assuming accessible for browser viewer:', error);
      canAccess = hasViewer; // If it's in a viewer, assume accessible
    }
  }
  
  const isPDF = hasViewer;
  console.log('  Other site PDF check:', { hasViewer, canAccess, isApplicationPdf, hasPdfElements, hasPdfJsGlobals, hasPdfLikeCanvas });

  // URL-based fallback for obvious PDF URLs
  let urlFallback = false;
  if (!isPDF) {
    const isPdfUrl = url.match(/\.pdf$/i) && !url.includes('?') && !url.includes('#');
    urlFallback = isPdfUrl && document.contentType !== 'text/html';
    console.log('  URL fallback check:', urlFallback);
  }
  
  const finalResult = isPDF || urlFallback;
  const finalCanAccess = finalResult ? canAccess : false;
  
  console.log('PDF content detection summary:', {
    isPublisherSite,
    publisherStrictCheck: isPublisherSite ? isPDF : 'N/A',
    contentType: isApplicationPdf,
    hasViewerElements: hasPdfElements,
    hasPdfJsGlobals: hasPdfJsGlobals,
    hasCanvasElements: hasPdfLikeCanvas,
    bodyHasPdfClass: bodyHasPdfClass,
    metaHasPdf: metaHasPdf,
    urlFallback: urlFallback,
    finalResult: finalResult,
    finalCanAccess: finalCanAccess
  });
  
  // Return object format to be consistent with other branches
  return { isPDF: finalResult, source: 'browser', canAccess: finalCanAccess };
}

// ---------------------------------------------------------------------------
// Paper landing-page detection (journal pages, SSRN, arXiv, NBER, RePEc, …).
// Reads the standard scholarly <meta> tags (citation_*, DC, og) that publishers
// embed — the same signals Google Scholar uses to show its PDF button.
// ---------------------------------------------------------------------------
function _meta(names) {
  for (const n of names) {
    const el = document.querySelector(`meta[name="${n}"]`) ||
               document.querySelector(`meta[property="${n}"]`) ||
               document.querySelector(`meta[name="${n.toUpperCase()}"]`);
    if (el && el.content && el.content.trim()) return el.content.trim();
  }
  return null;
}

function _absUrl(u) {
  try { return u ? new URL(u, window.location.href).href : null; } catch (_) { return u || null; }
}

// Build an ordered, de-duplicated list of candidate PDF URLs for this page.
// Crucial for paywalled journals where citation_pdf_url is absent but the page
// has a "Download PDF" button (e.g. SAGE/Wiley/T&F /doi/pdf/<doi>). These are
// fetched with the user's session cookies, so an entitled user gets the PDF the
// server can't.
function _collectPdfCandidates(doi) {
  const href = window.location.href;
  const origin = window.location.origin;
  const out = [];
  const push = (u) => { const a = _absUrl(u); if (a && !out.includes(a)) out.push(a); };

  // 1) Publisher-declared direct link.
  push(_meta(['citation_pdf_url']));
  const relPdf = document.querySelector('link[rel="alternate"][type="application/pdf"]');
  if (relPdf) push(relPdf.getAttribute('href'));

  // 2) On-page "Download PDF" anchors (rendered for entitled users).
  const anchors = Array.from(document.querySelectorAll('a[href]'));
  const pdfHrefRx = /\/doi\/(pdf|epdf|pdfdirect)\b|\/(pdf|epdf)\/|\.pdf(\?|$)|\/content\/pdf\/|\/article-pdf\//i;
  const pdfTextRx = /\b(download|full[\s-]*text|view|get|read)\b.*\bpdf\b|\bpdf\b/i;
  for (const a of anchors) {
    const h = a.getAttribute('href') || '';
    const txt = (a.textContent || '').trim().toLowerCase();
    if (pdfHrefRx.test(h)) push(h);
    else if (txt && txt.length < 40 && pdfTextRx.test(txt) && (h.includes('/doi/') || h.includes('pdf'))) push(h);
  }

  // 3) Derive publisher PDF URLs from the DOI / URL pattern.
  if (doi) {
    const d = doi;
    if (/sagepub\.com|tandfonline\.com|journals\.uchicago\.edu|dl\.acm\.org|royalsocietypublishing\.org/i.test(href)) {
      push(`${origin}/doi/pdf/${d}`); push(`${origin}/doi/epdf/${d}`);
    }
    if (/onlinelibrary\.wiley\.com/i.test(href)) {
      push(`${origin}/doi/pdfdirect/${d}`); push(`${origin}/doi/epdf/${d}`); push(`${origin}/doi/pdf/${d}`);
    }
    if (/link\.springer\.com/i.test(href)) {
      push(`https://link.springer.com/content/pdf/${d}.pdf`);
    }
    if (/emerald\.com/i.test(href)) {
      push(`${origin}/insight/content/doi/${d}/full/pdf`);
    }
  }
  // Generic: /doi/abs|full/<doi> → /doi/pdf|epdf/<doi> on the same host.
  const m = href.match(/(.*\/doi)\/(?:abs|full|figure|citedby)\/(.+?)(?:[?#].*)?$/i);
  if (m) { push(`${m[1]}/pdf/${m[2]}`); push(`${m[1]}/epdf/${m[2]}`); }

  return out;
}

function detectPaperPage() {
  const href = window.location.href;
  const low = href.toLowerCase();

  const citationTitle = _meta(['citation_title', 'dc.title', 'og:title']);
  let doi = _meta(['citation_doi', 'dc.identifier', 'prism.doi']);
  if (doi) doi = doi.replace(/^doi:/i, '').trim();
  if (!doi) {
    const m = href.match(/10\.\d{4,9}\/[^\s?&#]+/);
    if (m) doi = m[0];
  }

  // Host-specific helpers / direct PDF derivation.
  const isSSRN = low.includes('ssrn.com') && (low.includes('abstract_id=') || low.includes('abstract=') || /\/abstract=\d+/.test(low));
  const arxivAbs = href.match(/arxiv\.org\/abs\/([^\s?&#]+)/i);
  const isArxiv = !!arxivAbs;

  const pdfCandidates = _collectPdfCandidates(doi);
  if (isArxiv) pdfCandidates.push(`https://arxiv.org/pdf/${arxivAbs[1]}`);
  let pdfUrl = pdfCandidates[0] || null;

  const knownHost = isSSRN || isArxiv ||
    /nber\.org\/papers|ideas\.repec\.org|econpapers\.repec\.org|sciencedirect\.com|link\.springer\.com|onlinelibrary\.wiley\.com|jstor\.org|academic\.oup\.com|cambridge\.org\/core|aeaweb\.org|tandfonline\.com|journals\.uchicago\.edu|emerald\.com|mdpi\.com|nature\.com|dl\.acm\.org/.test(low);

  const hasAbstract = !!(document.querySelector('.abstract-text') ||
                         document.querySelector('[data-test-id="abstract"]') ||
                         document.querySelector('.abstract') ||
                         document.querySelector('#abstract'));

  const isImportable = !!pdfUrl || !!citationTitle || !!doi || knownHost || hasAbstract;
  // A PDF is considered "available" if we have a direct link or enough to resolve one.
  const pdfAvailable = !!pdfUrl || !!doi || !!citationTitle || isSSRN || isArxiv;

  const type = isSSRN ? 'ssrn' : (isArxiv ? 'arxiv' : (knownHost ? 'journal' : (hasAbstract ? 'article' : 'unknown')));
  const title = citationTitle || document.title;  // display title (may be the tab title)

  // `citationTitle` is the publisher-declared paper title — the only title
  // trustworthy enough to verify a *searched* PDF against. document.title is
  // not sent for verification (it's often the journal/site name).
  const result = { isImportable, pdfAvailable, type, url: href,
                   pdfUrl: pdfUrl || null, pdfCandidates,
                   doi: doi || null,
                   title, citationTitle: citationTitle || null };
  console.log('[Content Script] Paper page detection:', result);
  return result;
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  console.log('Content script received message:', request);
  
  if (request.action === 'ping') {
    // Simple ping response to check if content script is injected
    console.log('[Content Script] Received ping, responding with OK');
    console.log('[Content Script] Current URL:', window.location.href);
    console.log('[Content Script] Document ready state:', document.readyState);
    console.log('[Content Script] Document content type:', document.contentType);
    sendResponse({ status: 'ok', success: true, message: 'Content script is active' });
    return true;
  }
  
  if (request.action === 'checkContentType') {
    // Check the content type of the current page
    const contentType = document.contentType || '';
    console.log('Content type check:', contentType);
    sendResponse({ contentType: contentType });
    return true;
  }
  
  if (request.action === 'checkPDFElements') {
    // Check for PDF-related elements in the page - Enhanced version
    const pdfViewerElements = [
      'embed[type="application/pdf"]',
      'object[type="application/pdf"]',
      'object[data*=".pdf"]',
      'iframe[src*="pdf"]',
      'canvas[data-pdf-url]',
      '[data-pdf-viewer]',
      '.pdf-viewer',
      '#pdf-viewer',
      // PDF.js specific elements
      '#viewer',
      '#viewerContainer', 
      '.page[data-page-number]',
      '#pageContainer1',
      '[class*="pdfViewer"]',
      '[id*="pdfViewer"]',
      'canvas[data-main-rotation]',
      '.canvasWrapper canvas',
      '#outerContainer',
      '#mainContainer',
      '.toolbar',
      '#toolbarContainer'
    ];
    
    let foundElements = [];
    for (const selector of pdfViewerElements) {
      if (document.querySelector(selector)) {
        foundElements.push(selector);
      }
    }
    
    const hasPDFElements = foundElements.length > 0;
    console.log('Enhanced PDF elements check:', hasPDFElements, 'Found:', foundElements);
    sendResponse({ hasPDFElements: hasPDFElements, foundElements: foundElements });
    return true;
  }
  
  if (request.action === 'checkPDFStatus') {
    // Use the content-based isPDFPage function
    (async () => {
      try {
        const pdfResult = await isPDFPage();
        const isPDF = typeof pdfResult === 'boolean' ? pdfResult : pdfResult.isPDF;
        const canAccess = typeof pdfResult === 'object' ? pdfResult.canAccess : true;
        const source = typeof pdfResult === 'object' ? pdfResult.source : 'unknown';
        
        console.log('[Content Script] PDF status check via isPDFPage():', { isPDF, canAccess, source });
        console.log('[Content Script] Current URL for PDF check:', window.location.href);
        console.log('[Content Script] Document content type:', document.contentType);
        
        sendResponse({ 
          isPDF: isPDF, 
          canAccess: canAccess !== false, 
          source: source,
          accessibilityDetails: {
            contentType: document.contentType,
            url: window.location.href,
            protocol: window.location.protocol
          }
        });
      } catch (error) {
        console.error('[Content Script] Error in PDF status check:', error);
        sendResponse({ isPDF: false, canAccess: false, source: 'error' });
      }
    })();
    return true;
  }

  if (request.action === 'checkPDFAccessibility') {
    // Simplified PDF accessibility check
    (async () => {
      try {
        const pdfResult = await isPDFPage();
        const isPDF = typeof pdfResult === 'boolean' ? pdfResult : pdfResult.isPDF;
        
        if (!isPDF) {
          sendResponse({ isPDF: false, accessible: false });
          return;
        }

        // Simple accessibility checks
        let accessible = true;
        const contentType = document.contentType;
        const protocol = window.location.protocol;

        // Check if it's a proper PDF with content type
        const isProperPdf = contentType === 'application/pdf';
        
        // Check if we can access the content (for remote PDFs)
        if (protocol === 'https:' || protocol === 'http:') {
          try {
            const response = await fetch(window.location.href, {
              method: 'HEAD',
              credentials: 'include'
            });
            accessible = response.ok && (response.headers.get('content-type') || '').includes('pdf');
          } catch (error) {
            accessible = false;
          }
        }

        // For local files and proper PDFs, assume accessible
        if (protocol === 'file:' || isProperPdf) {
          accessible = true;
        }

        console.log('[Content Script] PDF accessibility check:', { isPDF, accessible, contentType, protocol });
        sendResponse({ isPDF, accessible });
      } catch (error) {
        console.error('[Content Script] Error in PDF accessibility check:', error);
        sendResponse({ isPDF: false, accessible: false });
      }
    })();
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'checkImportableStatus') {
    (async () => {
      try {
        sendResponse(detectPaperPage());
      } catch (error) {
        console.error('[Content Script] Error in importable status check:', error);
        sendResponse({ isImportable: false, error: error.message });
      }
    })();
    return true;
  }

  // Import a detected paper landing page. Prefer fetching the PDF with the
  // user's own session cookies (gets past paywalls the backend can't reach);
  // fall back to letting the backend resolve & download from url/doi/title.
  if (request.action === 'importDetectedPaper') {
    (async () => {
      const meta = request.meta || detectPaperPage();
      const landing = meta.url || window.location.href;
      let fileContent = null;

      // Try each candidate PDF link with the user's session cookies, stopping at
      // the first that returns real PDF bytes (entitled paywalled download).
      const candidates = (meta.pdfCandidates && meta.pdfCandidates.length)
        ? meta.pdfCandidates
        : (meta.pdfUrl ? [meta.pdfUrl] : []);
      for (const cand of candidates) {
        try {
          const res = await fetch(cand, { credentials: 'include' });
          if (!res.ok) continue;
          const ct = (res.headers.get('content-type') || '').toLowerCase();
          if (ct && !(ct.includes('pdf') || ct.includes('octet-stream'))) continue; // HTML login page, etc.
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          // Verify it really is a PDF (some paywalls serve an HTML login page with 200).
          if (bytes.length > 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) {
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            fileContent = btoa(binary);
            console.log('[Content Script] Fetched PDF with session cookies from', cand, '—', bytes.length, 'bytes');
            break;
          }
        } catch (e) {
          console.log('[Content Script] Cookie-aware PDF fetch failed for', cand, '-', e.message);
        }
      }

      chrome.runtime.sendMessage({
        action: 'proxyAnalyzeStream',
        file_content: fileContent,
        url: landing,
        pdf_url: meta.pdfUrl || null,
        doi: meta.doi || null,
        // Only the trusted publisher title is sent for backend verification.
        title: meta.citationTitle || null,
        source: 'browser_extension_paper_page'
      }, () => {});

      sendResponse({ started: true, hadBytes: !!fileContent });
    })();
    return true;
  }
  
  if (request.action === 'readPDFContent') {
    // Read PDF content from the current page
    console.log('[Content Script] Attempting to read PDF content from:', window.location.href);
    console.log('[Content Script] Document content type:', document.contentType);
    
    // Check PDF status asynchronously
    isPDFPage().then(result => {
      console.log('[Content Script] isPDFPage() result:', result);
    }).catch(error => {
      console.error('[Content Script] Error checking PDF status:', error);
    });
    
    // Immediately respond with a promise-like structure to avoid back/forward cache issues
    readPDFContentAsync()
      .then(result => {
        try {
          sendResponse(result);
        } catch (e) {
          console.error('Content script: Error sending response:', e);
        }
      })
      .catch(error => {
        try {
          sendResponse({ success: false, error: error.message });
        } catch (e) {
          console.error('Content script: Error sending error response:', e);
        }
      });
    
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'getPaperContent') {
    try {
      // Check if we already have the content
      if (currentState.content) {
        console.log('Using cached content');
        sendResponse({ content: currentState.content });
        return true;
      }
      
      // Extract paper content from the page
      console.log('Starting content extraction...');
      extractPaperContent().then(content => {
        console.log('Content extracted successfully:', content);
        currentState.content = content;
        // Update the background service worker
        if (port) {
          try {
            port.postMessage({
              action: 'updateTabState',
              state: { content }
            });
          } catch (error) {
            console.error('Error sending message to background:', error);
          }
        }
        sendResponse({ content });
      }).catch(error => {
        console.error('Error extracting content:', error);
        sendResponse({ error: error.message });
      });
    } catch (error) {
      console.error('Error in message handler:', error);
      sendResponse({ error: error.message });
    }
    return true; // Keep the message channel open for async response
  }
});

// Debug logging for injection
console.log('Content script loaded on URL:', window.location.href);
console.log('Content script attempting to initialize...');
console.log('Content script initialization state:', { 
  isInitialized: currentState.isInitialized,
  hasContent: !!currentState.content,
  windowPort: !!window.ssrnSummarizerPort
});

// Debug function for PDF detection testing
window.debugPDFDetection = async function() {
  console.log('=== PDF Detection Debug ===');
  const result = await isPDFPage();
  console.log('PDF Detection Result:', result);
  console.log('Document Content Type:', document.contentType);
  console.log('URL:', window.location.href);
  console.log('Title:', document.title);
  return result;
};

// Function to read PDF content asynchronously with better error handling
async function readPDFContentAsync() {
  try {
    console.log('[Content Script] Starting PDF read operation...');
    console.log('[Content Script] Target URL:', window.location.href);
    console.log('[Content Script] Document content type:', document.contentType);
    
    // First verify this is actually a PDF page
    const pdfCheck = await isPDFPage();
    console.log('[Content Script] isPDFPage() check result:', pdfCheck);
    
    if (!pdfCheck.isPDF) {
      throw new Error('This page is not detected as a PDF. If this is incorrect, please ensure you are on the actual PDF page, not a viewer or download page.');
    }
    
    // For local files, skip additional checks
    if (pdfCheck.source === 'local') {
      console.log('[Content Script] Local file detected, skipping additional checks');
    } else if (!pdfCheck.canAccess) {
      throw new Error('PDF detected but cannot be accessed. Please ensure you have proper permissions.');
    }
    
    // Prevent page from going into back/forward cache during PDF reading
    const beforeUnloadHandler = (e) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnloadHandler);
    
    // Also prevent page freezing
    const pageHideHandler = (e) => {
      e.preventDefault();
    };
    window.addEventListener('pagehide', pageHideHandler);
    
    try {
      // Method 1: Try to fetch with same-origin credentials
      let response;
      try {
        response = await fetch(window.location.href, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'default' // Use cache if available
        });
        console.log('[Content Script] Same-origin fetch successful, response status:', response.status);
      } catch (fetchError) {
        console.log('[Content Script] Same-origin fetch failed, trying include credentials:', fetchError.message);
        
        // Method 2: Try with include credentials  
        try {
          response = await fetch(window.location.href, {
            method: 'GET',
            credentials: 'include',
            cache: 'default'
          });
          console.log('[Content Script] Include credentials fetch successful, response status:', response.status);
        } catch (includeError) {
          console.log('[Content Script] Include credentials fetch failed, trying no-cors:', includeError.message);
          
          // Method 3: Try no-cors mode (won't give us the content but might work for some cases)
          response = await fetch(window.location.href, {
            method: 'GET',
            mode: 'no-cors',
            cache: 'default'
          });
          console.log('[Content Script] No-cors fetch successful, response type:', response.type);
        }
      }
    
      console.log('[Content Script] Final response:', { status: response.status, type: response.type, ok: response.ok });
    
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    
    const contentType = response.headers.get('content-type') || 'application/pdf';
    console.log('Content script: Response content type:', contentType);
    
    // For no-cors responses, we might not get headers, so assume PDF if we're on a PDF page
    if (response.type === 'opaque') {
      console.log('Content script: Got opaque response (no-cors), assuming PDF content');
    } else if (contentType && !contentType.includes('pdf')) {
      // Check if this might be a login/authentication page
      const isHtml = contentType.includes('html');
      const hasLoginIndicators = document.body && (
        document.body.innerHTML.toLowerCase().includes('login') ||
        document.body.innerHTML.toLowerCase().includes('sign in') ||
        document.body.innerHTML.toLowerCase().includes('authentication')
      );
      
      if (isHtml && hasLoginIndicators) {
        throw new Error('Detected login page - this appears to be a secure PDF requiring authentication');
      } else {
        throw new Error(`Not a PDF content type: ${contentType}. The server might be requesting authentication.`);
      }
    }
    
    const blob = await response.blob();
    if (blob.size === 0) {
      throw new Error('PDF content is empty');
    }
    
    console.log('Content script: Got blob, size:', blob.size, 'bytes');
    
    const arrayBuffer = await blob.arrayBuffer();
    const uint8Array = new Uint8Array(arrayBuffer);
    
    // Verify this looks like a PDF (starts with %PDF)
    const pdfSignature = String.fromCharCode(...uint8Array.slice(0, 4));
    if (pdfSignature !== '%PDF') {
      console.warn('Content script: Content does not appear to be a PDF, signature:', pdfSignature);
      // Continue anyway, might still work
    }
    
    console.log('Content script: Converting to base64...');
    
    // Convert to base64 in chunks to avoid memory issues
    let binary = '';
    const chunkSize = 0x8000; // 32KB chunks
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    const base64Content = btoa(binary);
    
      console.log('Content script: Successfully read PDF, size:', base64Content.length, 'base64 chars');
      
      return { 
        success: true, 
        content: base64Content,
        size: uint8Array.length,
        contentType: contentType
      };
      
    } finally {
      // Clean up event listeners
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      window.removeEventListener('pagehide', pageHideHandler);
    }
    
  } catch (error) {
    console.error('Content script: Error reading PDF:', error);
    // Clean up event listeners in case of error
    try {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
      window.removeEventListener('pagehide', pageHideHandler);
    } catch (cleanupError) {
      // Ignore cleanup errors
    }
    throw error;
  }
}

// Initialize when the script loads (only if not already initialized)
if (!currentState.isInitialized) {
  // Try immediate initialization first
  try {
    initialize();
    console.log('Content script: Immediate initialization completed successfully');
  } catch (error) {
    console.log('Content script: Immediate initialization failed, trying delayed initialization:', error);
    
    // Add a small delay to ensure proper initialization
    setTimeout(() => {
      if (!currentState.isInitialized) {
        console.log('Content script initializing after delay...');
        try {
          initialize();
          console.log('Content script: Delayed initialization completed successfully');
        } catch (error) {
          console.error('Content script: Delayed initialization failed:', error);
          // Mark as initialized anyway to prevent infinite retries
          currentState.isInitialized = true;
        }
      }
    }, 100);
  }
}

async function extractPaperContent() {
  console.log('Starting content extraction...');
  
  // Check if we're on a PDF page
  const pdfResult = await isPDFPage();
  const isPDF = typeof pdfResult === 'boolean' ? pdfResult : pdfResult.isPDF;
  
  if (isPDF) {
    console.log('PDF page detected');
    return await extractPdfContent();
  }
  
  // If not a PDF, proceed with SSRN page extraction
  return await extractSSRNContent();
}

async function extractPdfContent() {
  try {
    console.log('Preparing PDF content for backend processing...');
    
    // For local files, we need to handle them differently
    if (window.location.protocol === 'file:') {
      console.log('Local PDF file detected');
      
      // Create a content object with file information
      const fileName = window.location.pathname.split('/').pop();
      const content = {
        title: document.title || fileName || 'PDF Document',
        paperId: fileName,
        paperUrl: window.location.href,
        isLocalFile: true,
        hasPdf: true,
        isPdf: true,
        abstract: 'PDF content will be extracted by the backend',
        authors: [],
        affiliations: [],
        keywords: []
      };
      
      // For local files, provide file information for seamless transition to full page interface
      content.fileInfo = {
        fileName: fileName,
        filePath: window.location.pathname,
        fileUrl: window.location.href
      };
      
      // Mark as local file that should open full page interface
      content.requiresFullPageInterface = true;
      content.localFileInfo = {
        fileName: content.fileInfo.fileName,
        filePath: content.fileInfo.filePath,
        message: `Local PDF detected: ${content.fileInfo.fileName}

The extension will automatically open the Full Page Interface where you can upload this file for analysis.`
      };
      
      console.log('PDF content prepared for backend processing:', content);
      return content;
    }
    
    // For SSRN PDFs, extract the ID from the URL
    const paperId = extractSsrnIdFromUrl(window.location.href);
    
    // Create a content object with paper information
    const content = {
      title: document.title || 'PDF Document',
      paperId: paperId,
      paperUrl: window.location.href,
      hasPdf: true,
      isPdf: true,
      abstract: 'PDF content will be extracted by the backend',
      authors: [],
      affiliations: [],
      keywords: []
    };
    
    console.log('PDF content prepared for backend processing:', content);
    return content;
  } catch (error) {
    console.error('Error preparing PDF content:', error);
    throw new Error('Failed to prepare PDF content: ' + error.message);
  }
}

async function extractSSRNContent() {
  console.log('Extracting content from SSRN page...');
  
  // Get the paper title
  const title = document.querySelector('h1.title')?.textContent?.trim() ||
                document.querySelector('.title-text')?.textContent?.trim() ||
                document.querySelector('h1')?.textContent?.trim() ||
                document.querySelector('.paper-title')?.textContent?.trim();
  console.log('Title:', title);
  
  // Get the abstract
  const abstract = document.querySelector('.abstract-text')?.textContent?.trim() ||
                  document.querySelector('[data-test-id="abstract"]')?.textContent?.trim() ||
                  document.querySelector('.abstract')?.textContent?.trim() ||
                  document.querySelector('#abstract')?.textContent?.trim();
  console.log('Abstract length:', abstract?.length);

  // Extract authors - try multiple selectors with improved logic
  let authors = [];
  let affiliations = [];

  console.log('Starting author extraction...');

  // Debug: Log page structure for author elements
  console.log('=== AUTHOR EXTRACTION DEBUG ===');
  console.log('Page URL:', window.location.href);
  console.log('Page title:', document.title);
  
  // Debug: Check what elements exist that might contain authors
  const potentialAuthorElements = document.querySelectorAll('[class*="author"], [data-test*="author"], [id*="author"]');
  console.log(`Found ${potentialAuthorElements.length} potential author elements:`);
  potentialAuthorElements.forEach((el, i) => {
    if (i < 10) { // Log first 10 to avoid spam
      console.log(`  ${i+1}. ${el.tagName}.${el.className} - "${el.textContent.slice(0, 100)}"`);
    }
  });

  // Try modern SSRN selectors first
  const modernAuthorSelectors = [
    'a[href*="/author/"]',  // Author profile links
    '.author-name a',
    '[data-testid="author-name"] a',
    '.authors a[href*="author"]',
    '.author-list a[href*="author"]'
  ];

  // Try each modern selector
  for (const selector of modernAuthorSelectors) {
    const elements = document.querySelectorAll(selector);
    if (elements.length > 0) {
      console.log(`Found ${elements.length} authors using selector: ${selector}`);
      authors = Array.from(elements).map(el => el.textContent.trim()).filter(name => name);
      break;
    }
  }

  // Fallback: SSRN classic layout - <h2> tags inside .authors.authors-full-width
  if (authors.length === 0) {
    const classicAuthorsDiv = document.querySelector('.authors.authors-full-width');
    if (classicAuthorsDiv) {
      const h2s = classicAuthorsDiv.querySelectorAll('h2');
      if (h2s.length > 0) {
        authors = Array.from(h2s).map(h2 => h2.textContent.trim()).filter(name => name);
        console.log(`Found ${authors.length} authors using classic SSRN <h2> extraction.`);
      }
    }
  }

  // If no authors found with link selectors, try text-based extraction
  if (authors.length === 0) {
    console.log('No authors found with link selectors, trying text-based extraction...');
    
    const textBasedSelectors = [
      '.authors',
      '.author-list', 
      '.authors-list',
      '.author-names',
      '[data-testid="authors"]',
      '.paper-authors',
      '#authors'
    ];

    for (const selector of textBasedSelectors) {
      const authorSection = document.querySelector(selector);
      if (authorSection) {
        console.log(`Found author section with selector: ${selector}`);
        const authorText = authorSection.textContent.trim();
        console.log('Author section text:', authorText);
        
        // Split by common separators and clean up
        authors = authorText
          .split(/[,;]|and\s+/)  // Split by comma, semicolon, or "and"
          .map(name => name.trim())
          .filter(name => 
            name && 
            name.length > 2 && 
            !name.toLowerCase().includes('abstract') && 
            !name.toLowerCase().includes('download') &&
            !name.toLowerCase().includes('view') &&
            !name.toLowerCase().includes('pdf') &&
            !/^\d+$/.test(name)  // Exclude pure numbers
          );
        
        if (authors.length > 0) {
          console.log(`Extracted ${authors.length} authors from text`);
          break;
        }
      }
    }
  }

  // Try to get affiliations with improved selectors
  const affiliationSelectors = [
    '.author-affiliation',
    '.affiliation',
    '[data-testid="author-affiliation"]',
    '.author-info .affiliation',
    '.author-affiliations'
  ];

  for (const selector of affiliationSelectors) {
    const affiliationElements = document.querySelectorAll(selector);
    if (affiliationElements.length > 0) {
      affiliations = Array.from(affiliationElements).map(el => el.textContent.trim()).filter(aff => aff);
      console.log(`Found ${affiliations.length} affiliations`);
      break;
    }
  }

  console.log('Final extracted authors:', authors);
  console.log('Final extracted affiliations:', affiliations);
  
  // Look for PDF download link first
  const pdfLink = document.querySelector('a[href*=".pdf"]') || 
                 document.querySelector('a[href*="download"]') ||
                 document.querySelector('a[href*="view"]') ||
                 document.querySelector('[data-test-id="download-pdf"]');
  
  let pdfUrl = null;
  if (pdfLink) {
    console.log('PDF link found:', pdfLink.href);
    pdfUrl = pdfLink.href;
    // If it's a relative URL, make it absolute
    if (pdfUrl.startsWith('/')) {
      pdfUrl = new URL(pdfUrl, window.location.origin).href;
    }
  } else {
    console.log('No PDF link found on page');
  }

  // Get paper ID and URL
  const paperId = extractSsrnIdFromUrl(window.location.href);
  const paperUrl = window.location.href;
  
  // Return the content object
  return {
    title,
    abstract,
    paperId,
    paperUrl,
    pdfUrl,
    hasPdf: !!pdfUrl,
    isPdf: false,
    authors,
    affiliations,
    keywords: []  // Will be extracted by backend
  };
}

// Use shared ID generator for consistent paper ID generation
async function extractSsrnIdFromUrl(url) {
  if (!url) return null;
  
  // Use the shared ID generator which matches backend logic
  try {
    const paperId = await SharedIdGenerator.generateIdFromUrl(url);
    return paperId;
  } catch (error) {
    console.error('Error generating paper ID:', error);
    // Fallback to simple SSRN ID extraction
    const match = url.match(/[?&]abstract(?:_?id)?=(\d+)/i);
    return match ? match[1] : url;
  }
}
