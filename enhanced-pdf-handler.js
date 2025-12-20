// Enhanced PDF Detection and Content Injection for Popup.js
// This file contains improved PDF handling functions that fix detection and injection issues

/**
 * Improved PDF detection that uses multiple detection methods
 * and provides detailed information about PDF accessibility
 */
async function checkIfPDFPage(tab) {
  try {
    console.log('[PDF Check] Starting comprehensive PDF detection for:', tab.url);
    
    // Method 1: Check if background script has already detected this as PDF
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'checkPDFStatus',
        tabId: tab.id
      });
      
      if (response && response.isPDF) {
        console.log('[PDF Check] Background script confirms PDF');
        return {
          isPDF: true,
          accessible: true,
          method: 'background-detection'
        };
      }
    } catch (e) {
      console.log('[PDF Check] Background check failed:', e.message);
    }
    
    // Method 2: URL-based detection with smart patterns
    const url = tab.url.toLowerCase();
    const urlPatterns = [
      { pattern: /\.pdf$/i, confidence: 'high' },
      { pattern: /\.pdf\?/i, confidence: 'high' },
      { pattern: /\/pdf\//i, confidence: 'medium' },
      { pattern: /pdf\./i, confidence: 'medium' },
      { pattern: /viewer\.pdf/i, confidence: 'high' },
      { pattern: /pdfjs/i, confidence: 'high' }
    ];
    
    let urlConfidence = null;
    for (const { pattern, confidence } of urlPatterns) {
      if (pattern.test(url)) {
        urlConfidence = confidence;
        break;
      }
    }
    
    // Method 3: Protocol-based detection
    const isFileProtocol = tab.url.startsWith('file://');
    const isDataProtocol = tab.url.startsWith('data:application/pdf');
    const isBlobProtocol = tab.url.startsWith('blob:');
    
    // Method 4: Title-based detection
    const title = (tab.title || '').toLowerCase();
    const titleIndicators = {
      hasPdfExtension: title.includes('.pdf'),
      hasPdfViewer: title.includes('pdf viewer') || title.includes('pdf.js'),
      hasAdobeReader: title.includes('adobe') && title.includes('reader'),
      hasChromeViewer: title.includes('pdf') && (title.includes('chrome') || title.includes('edge'))
    };
    
    const hasTitleIndicator = Object.values(titleIndicators).some(v => v);
    
    // Method 5: Try content script for definitive check (if possible and URL is accessible)
    let contentScriptResult = null;
    if (!isFileProtocol && !isDataProtocol && !isBlobProtocol && isUrlAccessibleForContentScript(tab.url)) {
      try {
        // Ensure content script is injected
        await ensureContentScriptWithRetry(tab.id);
        
        // Query content script
        const response = await chrome.tabs.sendMessage(tab.id, { 
          action: 'checkPDFStatus' 
        }, { frameId: 0 });
        
        if (response) {
          contentScriptResult = response;
          console.log('[PDF Check] Content script result:', contentScriptResult);
        }
      } catch (e) {
        console.log('[PDF Check] Content script check failed:', e.message);
      }
    } else if (!isUrlAccessibleForContentScript(tab.url)) {
      console.log('[PDF Check] Skipping content script check - URL not accessible for injection');
    }
    
    // Combine all detection methods for final decision
    const isPDF = !!(
      (contentScriptResult && contentScriptResult.isPDF) ||
      isFileProtocol ||
      isDataProtocol ||
      urlConfidence === 'high' ||
      (urlConfidence === 'medium' && hasTitleIndicator)
    );
    
    // Determine accessibility
    let accessible = false;
    let accessibilityReason = 'unknown';
    
    if (isPDF) {
      if (isFileProtocol) {
        accessible = true;
        accessibilityReason = 'local-file';
      } else if (isDataProtocol || isBlobProtocol) {
        accessible = true;
        accessibilityReason = 'embedded-data';
      } else if (contentScriptResult && contentScriptResult.canAccess) {
        accessible = true;
        accessibilityReason = 'content-script-confirmed';
      } else if (url.includes('drive.google.com') || url.includes('dropbox.com')) {
        accessible = false;
        accessibilityReason = 'cloud-storage-restricted';
      } else {
        // Try to check if URL is accessible
        try {
          const checkResponse = await fetch(tab.url, { 
            method: 'HEAD',
            mode: 'no-cors'
          });
          accessible = true;
          accessibilityReason = 'fetch-successful';
        } catch (e) {
          accessible = false;
          accessibilityReason = 'fetch-failed';
        }
      }
    }
    
    console.log('[PDF Check] Final result:', {
      isPDF,
      accessible,
      accessibilityReason,
      url: tab.url.substring(0, 100)
    });
    
    return {
      isPDF,
      accessible,
      method: accessibilityReason,
      details: {
        urlConfidence,
        hasTitleIndicator,
        isFileProtocol,
        contentScriptResult
      }
    };
    
  } catch (error) {
    console.error('[PDF Check] Unexpected error:', error);
    return { isPDF: false, accessible: false, error: error.message };
  }
}

/**
 * Helper function to check if a URL is accessible for content script injection
 */
function isUrlAccessibleForContentScript(url) {
  if (!url || typeof url !== 'string') {
    return false;
  }
  
  const lowerUrl = url.toLowerCase();
  
  // Chrome extension system and special pages
  const restrictedPrefixes = [
    'chrome://',
    'chrome-extension://',
    'moz-extension://',
    'safari-extension://',
    'edge-extension://',
    'about:',
    'chrome-search://',
    'chrome-devtools://',
    'devtools://',
    'view-source:'
  ];
  
  // Check if URL starts with any restricted prefix
  for (const prefix of restrictedPrefixes) {
    if (lowerUrl.startsWith(prefix)) {
      console.log(`[Content Script] URL not accessible: ${prefix} URLs are restricted`);
      return false;
    }
  }
  
  // Additional restrictions for Chrome Web Store and other system pages
  const restrictedDomains = [
    'chrome.google.com/webstore',
    'chromewebstore.google.com',
    'addons.mozilla.org',
    'microsoftedge.microsoft.com/addons'
  ];
  
  for (const domain of restrictedDomains) {
    if (lowerUrl.includes(domain)) {
      console.log(`[Content Script] URL not accessible: ${domain} is restricted`);
      return false;
    }
  }
  
  return true;
}

/**
 * Enhanced content script injection with better retry logic and URL validation
 */
async function ensureContentScriptWithRetry(tabId, maxRetries = 3) {
  try {
    // First, get the tab to check its URL
    const tab = await chrome.tabs.get(tabId);
    
    if (!tab || !tab.url) {
      throw new Error('Tab not found or has no URL');
    }
    
    // Check if the URL is accessible for content script injection
    if (!isUrlAccessibleForContentScript(tab.url)) {
      throw new Error(`Cannot access a ${tab.url.split('://')[0]}:// URL`);
    }
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // First, check if content script is already present
        try {
          const pingResponse = await chrome.tabs.sendMessage(tabId, 
            { action: 'ping' }, 
            { frameId: 0 }
          );
          
          if (pingResponse && pingResponse.status === 'ok') {
            console.log('[Content Script] Already injected and responsive');
            return true;
          }
        } catch (e) {
          // Content script not present, inject it
        }
        
        // Inject the content script
        console.log(`[Content Script] Injecting (attempt ${attempt}/${maxRetries})`);
        
        await chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ['shared-id-generator.js', 'content.js'],
          world: 'ISOLATED'
        });
        
        // Wait for initialization
        await new Promise(resolve => setTimeout(resolve, 300));
        
        // Verify injection succeeded
        const verifyResponse = await chrome.tabs.sendMessage(tabId, 
          { action: 'ping' }, 
          { frameId: 0 }
        );
        
        if (verifyResponse && verifyResponse.status === 'ok') {
          console.log('[Content Script] Successfully injected and verified');
          return true;
        }
        
      } catch (error) {
        console.error(`[Content Script] Injection attempt ${attempt} failed:`, error);
        
        if (attempt === maxRetries) {
          throw new Error(`Failed to inject content script after ${maxRetries} attempts: ${error.message}`);
        }
        
        // Wait before retry with exponential backoff
        await new Promise(resolve => setTimeout(resolve, 500 * attempt));
      }
    }
    
    return false;
  } catch (error) {
    console.error('[Content Script] URL validation or injection failed:', error);
    throw error;
  }
}

/**
 * Improved PDF content reading with multiple fallback methods
 */
async function readPDFContent(tab) {
  console.log('[PDF Reader] Starting PDF content extraction for:', tab.url);
  
  const results = {
    success: false,
    content: null,
    size: 0,
    method: null,
    error: null
  };
  
  // Method 1: Try PDF collector if available
  try {
    const collectorResponse = await chrome.runtime.sendMessage({
      action: 'getPDFFromCollector',
      tabId: tab.id
    });
    
    if (collectorResponse && collectorResponse.content) {
      console.log('[PDF Reader] Got content from PDF collector');
      results.success = true;
      results.content = collectorResponse.content;
      results.size = collectorResponse.size || 0;
      results.method = 'pdf-collector';
      return results;
    }
  } catch (e) {
    console.log('[PDF Reader] PDF collector not available:', e.message);
  }
  
  // Method 2: Try content script (if URL is accessible)
  if (isUrlAccessibleForContentScript(tab.url)) {
    try {
      await ensureContentScriptWithRetry(tab.id);
      
      const contentResponse = await chrome.tabs.sendMessage(tab.id, 
        { action: 'readPDFContent' },
        { frameId: 0 }
      );
      
      if (contentResponse && contentResponse.success && contentResponse.content) {
        console.log('[PDF Reader] Got content from content script');
        results.success = true;
        results.content = contentResponse.content;
        results.size = contentResponse.size || 0;
        results.method = 'content-script';
        return results;
      }
    } catch (e) {
      console.log('[PDF Reader] Content script method failed:', e.message);
      results.error = e.message;
    }
  } else {
    console.log('[PDF Reader] Skipping content script method - URL not accessible for injection');
  }
  
  // Method 3: Direct fetch for accessible URLs
  if (!tab.url.startsWith('file://') && !tab.url.startsWith('chrome-extension://')) {
    try {
      console.log('[PDF Reader] Attempting direct fetch');
      
      const response = await fetch(tab.url, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/pdf,*/*'
        }
      });
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('pdf')) {
        throw new Error(`Not a PDF: ${contentType}`);
      }
      
      const blob = await response.blob();
      const arrayBuffer = await blob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);
      
      // Verify PDF signature
      const signature = String.fromCharCode(...uint8Array.slice(0, 4));
      if (signature !== '%PDF') {
        throw new Error('Invalid PDF signature');
      }
      
      // Convert to base64
      const base64 = await convertToBase64Chunked(uint8Array);
      
      console.log('[PDF Reader] Direct fetch successful');
      results.success = true;
      results.content = base64;
      results.size = uint8Array.length;
      results.method = 'direct-fetch';
      return results;
      
    } catch (e) {
      console.log('[PDF Reader] Direct fetch failed:', e.message);
      results.error = e.message;
    }
  }
  
  // Method 4: For local files, try File API (if URL is accessible)
  if (tab.url.startsWith('file://') && isUrlAccessibleForContentScript(tab.url)) {
    try {
      // Inject a special script to read local file
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            const response = await fetch(window.location.href);
            const blob = await response.blob();
            const arrayBuffer = await blob.arrayBuffer();
            const uint8Array = new Uint8Array(arrayBuffer);
            
            // Convert to base64 in chunks
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
              const chunk = uint8Array.subarray(i, i + chunkSize);
              binary += String.fromCharCode.apply(null, chunk);
            }
            
            return {
              success: true,
              content: btoa(binary),
              size: uint8Array.length
            };
          } catch (error) {
            return {
              success: false,
              error: error.message
            };
          }
        }
      });
      
      if (result.result && result.result.success) {
        console.log('[PDF Reader] Local file read successful');
        results.success = true;
        results.content = result.result.content;
        results.size = result.result.size;
        results.method = 'local-file-api';
        return results;
      }
    } catch (e) {
      console.log('[PDF Reader] Local file method failed:', e.message);
      results.error = e.message;
    }
  } else if (tab.url.startsWith('file://') && !isUrlAccessibleForContentScript(tab.url)) {
    console.log('[PDF Reader] Skipping local file method - URL not accessible for injection');
  }
  
  // If all methods failed, return error
  results.error = results.error || 'All PDF reading methods failed';
  console.error('[PDF Reader] Failed to read PDF:', results.error);
  return results;
}

/**
 * Helper function to convert Uint8Array to base64 in chunks
 */
async function convertToBase64Chunked(uint8Array) {
  return new Promise((resolve) => {
    let binary = '';
    const chunkSize = 0x8000; // 32KB chunks
    
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      const chunk = uint8Array.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    
    resolve(btoa(binary));
  });
}

/**
 * Enhanced PDF analysis function with better error handling
 */
async function analyzePDFWithImprovedHandling(tab, paperId) {
  try {
    console.log('[PDF Analysis] Starting enhanced analysis for:', paperId);
    
    // Step 1: Verify this is actually a PDF
    const pdfCheck = await checkIfPDFPage(tab);
    if (!pdfCheck.isPDF) {
      throw new Error('This page is not detected as a PDF. Please navigate to a PDF file.');
    }
    
    if (!pdfCheck.accessible) {
      throw new Error(`PDF is not accessible: ${pdfCheck.method}. Please ensure the PDF is loaded and you have permission to access it.`);
    }
    
    // Step 2: Read PDF content
    showStatus('Reading PDF content...', 'info');
    const pdfContent = await readPDFContent(tab);
    
    if (!pdfContent.success) {
      // If reading failed, we can still try sending just the URL to backend
      console.warn('[PDF Analysis] Could not read PDF content, will send URL only');
      showStatus('Could not read PDF directly, backend will attempt to download...', 'warning');
    }
    
    // Step 3: Get user settings
    const settings = await chrome.storage.local.get(['llmSettings', 'userSettings']);
    const llmSettings = settings.llmSettings || { model: 'gemini-3-flash-preview' };
    const userSettings = settings.userSettings || {};
    
    // Step 4: Check backend availability
    const backend = await BackendManager.getCurrentBackend();
    if (!backend) {
      throw new Error('No backend server available. Please check your connection.');
    }
    
    // Step 5: Prepare analysis payload
    const payload = {
      content: {
        paperUrl: tab.url,
        paperId: paperId,
        isLocalFile: tab.url.startsWith('file://')
      },
      model: llmSettings.model,
      user_scholar_url: userSettings.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en',
      research_interests: userSettings.researchInterests || ''
    };
    
    // Add PDF content if successfully read
    if (pdfContent.success && pdfContent.content) {
      payload.file_content = pdfContent.content;
      console.log('[PDF Analysis] Including PDF content in payload (method:', pdfContent.method, ')');
    }
    
    // No API keys needed - backend handles all LLM API keys
    
    // Step 6: Send to backend for analysis
    showStatus('Analyzing PDF content...', 'progress');
    
    const response = await makeApiRequestWithBackend(CONFIG.ANALYZE_STREAM_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(payload)
    }, backend);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend error: ${response.status} - ${errorText}`);
    }
    
    const result = await response.json();
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    console.log('[PDF Analysis] Analysis completed successfully');
    return result;
    
  } catch (error) {
    console.error('[PDF Analysis] Error:', error);
    throw error;
  }
}

// Export for use in popup.js
window.PDFHandler = {
  checkIfPDFPage,
  ensureContentScriptWithRetry,
  readPDFContent,
  analyzePDFWithImprovedHandling,
  isUrlAccessibleForContentScript
};
