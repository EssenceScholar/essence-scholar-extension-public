importScripts('capture-sources.js');   // CAPTURE_SOURCES + captureSourceKeyFor

// Service worker configuration for Essence Scholar Extension
const CONFIG = {
  // Backend configuration with priority order
  BACKENDS: {
    NIGHTLY: {
      url: 'https://nightly-api.essencescholar.com',
      name: 'Nightly (testing)',
      // Off by default: production now has the download-capture filing and the
      // newsletter-picks endpoints, so the shipped extension targets prod (SELF_HOSTED,
      // priority 1). Flip to priority 0 / enabled true only to test against nightly.
      // (Was flipped on 2026-09-05 to test attended browsing before those routes
      // existed on production. They are on production now, so it is off again.)
      priority: 99,
      enabled: false
    },
    LOCAL_DEV: {
      url: 'http://localhost:8080',
      name: 'Local Development',
      priority: 99,
      enabled: false
    },
    SELF_HOSTED: {
      url: 'https://scholar-api.essencescholar.com',
      name: 'Self-Hosted (always-on)',
      priority: 1,
      enabled: true
    },
    CLOUD_RUN: {
      url: 'https://ssrn-summarizer-backend-pisqy7uvxq-uc.a.run.app',
      name: 'Cloud Run',
      priority: 2,
      enabled: true
    }
  },
  
  // Current backend (will be set dynamically)
  BACKEND_URL: null,
  CURRENT_BACKEND: null,
  
  // API endpoints
  CHAT_ENDPOINT: '/chat',
  HEALTH_ENDPOINT: '/health',
  ANALYZE_AUTHORS_ENDPOINT: '/analyze-authors',
  AUTHOR_DATA_ENDPOINT: '/authors',
  ALL_AUTHOR_DATA_ENDPOINT: '/authors/all',
  ANALYZE_STREAM_ENDPOINT: '/analyze-stream',
  INGEST_ENDPOINT: '/ingest', // Lightweight two-phase ingest — fast paperID, OCR in background

  // Timeouts
  REQUEST_TIMEOUT: 60000, // 60 seconds for local
  CLOUD_REQUEST_TIMEOUT: 120000, // 120 seconds for cloud
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000, // 1 second
  HEALTH_CHECK_TIMEOUT: 3000, // 3s — tunnel-backed hosts (nightly/self-hosted) can be slow to first byte on cold start
  
  // Analysis settings
  MAX_CONTENT_LENGTH: 50000, // characters
  ANALYSIS_CACHE_DURATION: 5 * 60 * 1000, // 5 minutes in milliseconds
  
  // Backend detection settings
  BACKEND_CACHE_DURATION: 5 * 60 * 1000, // Cache backend choice for 5 minutes
  AUTO_DETECT_BACKENDS: true, // Re-enabled automatic backend detection
  PREFER_LOCAL: true, // Prefer local backends over cloud
  
  // Backend failure tracking
  MAX_CONSECUTIVE_FAILURES: 2, // Show update message after 2 consecutive failures
  FAILURE_RESET_DURATION: 10 * 60 * 1000, // Reset failure count after 10 minutes
};

// Service worker compatible BackendManager with health checks
class ServiceWorkerBackendManager {
  // Track consecutive failures
  static _consecutiveFailures = 0;
  static _lastFailureTime = 0;
  static _updateMessageShown = false;
  static _cachedBackend = null;
  static _cachedTime = 0;

  // Get the priority 1 backend directly
  static getPriorityOneBackend() {
    const backends = Object.entries(CONFIG.BACKENDS)
      .filter(([key, backend]) => backend.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority);
    
    if (backends.length > 0) {
      const [key, backend] = backends[0];
      return { key, ...backend };
    }
    return null;
  }

  // Get current backend with health check fallback
  static async getCurrentBackend() {
    const now = Date.now();
    if (ServiceWorkerBackendManager._cachedBackend && (now - ServiceWorkerBackendManager._cachedTime < CONFIG.BACKEND_CACHE_DURATION)) {
      return ServiceWorkerBackendManager._cachedBackend;
    }
    
    let backend = null;
    if (CONFIG.AUTO_DETECT_BACKENDS) {
      backend = await ServiceWorkerBackendManager.detectBestBackend();
    } else {
      backend = ServiceWorkerBackendManager.getPriorityOneBackend();
    }

    if (backend) {
      ServiceWorkerBackendManager._cachedBackend = backend;
      ServiceWorkerBackendManager._cachedTime = now;
      console.log(`🎯 Service Worker using backend: ${backend.name} (${backend.url})`);
    }
    return backend;
  }

  // Detect the best available backend by checking health
  static async detectBestBackend() {
    const backends = ServiceWorkerBackendManager.getBackendsByPriority();
    
    for (const backend of backends) {
      const isHealthy = await ServiceWorkerBackendManager.checkBackendHealth(backend);
      if (isHealthy) {
        return backend;
      }
    }
    
    return backends[0] || null;
  }

  // Check backend health by pinging the /health endpoint
  static async checkBackendHealth(backend) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), CONFIG.HEALTH_CHECK_TIMEOUT);
      
      const response = await fetch(`${backend.url}${CONFIG.HEALTH_ENDPOINT}`, {
        method: 'GET',
        signal: controller.signal
      });
      
      clearTimeout(timeoutId);
      return response.ok;
    } catch (error) {
      console.log(`⚠️ SW Health check failed for ${backend.name}: ${error.message}`);
      return false;
    }
  }

  // Force refresh backend choice
  static async refreshBackend() {
    ServiceWorkerBackendManager._cachedBackend = null;
    ServiceWorkerBackendManager._cachedTime = 0;
    console.log('🔄 Forced backend refresh in Service Worker');
    return await ServiceWorkerBackendManager.getCurrentBackend();
  }

  // Track backend failure and show update message if needed
  static trackBackendFailure(error = null) {
    const now = Date.now();
    
    // Reset failure count if enough time has passed
    if (now - ServiceWorkerBackendManager._lastFailureTime > CONFIG.FAILURE_RESET_DURATION) {
      ServiceWorkerBackendManager._consecutiveFailures = 0;
      ServiceWorkerBackendManager._updateMessageShown = false;
    }
    
    ServiceWorkerBackendManager._consecutiveFailures++;
    ServiceWorkerBackendManager._lastFailureTime = now;
    
    console.log(`❌ Backend failure #${ServiceWorkerBackendManager._consecutiveFailures} tracked`);
    
    // Show update message after 2 consecutive failures
    if (ServiceWorkerBackendManager._consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES && !ServiceWorkerBackendManager._updateMessageShown) {
      ServiceWorkerBackendManager._updateMessageShown = true;
      ServiceWorkerBackendManager.showUpdateMessage();
    }
  }

  // Show user-friendly update message
  static showUpdateMessage() {
    console.log('⚠️ Showing extension update message to user');
    
    // Create a user-friendly message
    const message = {
      type: 'extension_update_required',
      title: 'Extension Update Required',
      message: 'Your extension needs to be updated to work with the latest backend. Please update the extension from the Chrome Web Store.',
      action: 'update_extension',
      timestamp: Date.now()
    };
    
    // Try to show the message in different contexts
    try {
      // Method 1: Send message to popup if available
      if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
        chrome.runtime.sendMessage({
          action: 'showUpdateMessage',
          message: message
        }).catch(() => {
          // Ignore errors if popup is not available
        });
      }
      
      // Method 2: Store message for popup to read
      if (typeof chrome !== 'undefined' && chrome.storage) {
        chrome.storage.local.set({
          'extension_update_message': message
        }).catch(() => {
          // Ignore storage errors
        });
      }
      
    } catch (error) {
      console.error('Error showing update message:', error);
    }
  }

  // Reset failure tracking (call this on successful requests)
  static resetFailureTracking() {
    ServiceWorkerBackendManager._consecutiveFailures = 0;
    ServiceWorkerBackendManager._lastFailureTime = 0;
    ServiceWorkerBackendManager._updateMessageShown = false;
    console.log('✅ Backend failure tracking reset');
  }

  // Get current failure status
  static getFailureStatus() {
    return {
      consecutiveFailures: ServiceWorkerBackendManager._consecutiveFailures,
      lastFailureTime: ServiceWorkerBackendManager._lastFailureTime,
      updateMessageShown: ServiceWorkerBackendManager._updateMessageShown,
      shouldShowUpdate: ServiceWorkerBackendManager._consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES
    };
  }

  // Helper method for compatibility
  static getBackendsByPriority() {
    return Object.entries(CONFIG.BACKENDS)
      .filter(([key, backend]) => backend.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority)
      .map(([key, backend]) => ({ key, ...backend }));
  }
}

// Helper function to make API requests with explicit backend
// Helper function to get API key from storage (for background script)
async function getApiKeyBackground() {
  let apiKey = null;
  
  // 1. Try chrome.storage.local with key 'essenceScholarApiKey' (from saveSettings)
  try {
    const localResult = await chrome.storage.local.get(['essenceScholarApiKey']);
    if (localResult.essenceScholarApiKey) {
      apiKey = localResult.essenceScholarApiKey;
    }
  } catch (error) {
    console.log('Error accessing chrome.storage.local:', error);
  }
  
  // 2. Try chrome.storage.sync with key 'essence_scholar_api_key' (from onboarding)
  if (!apiKey) {
    try {
      const syncResult = await chrome.storage.sync.get(['essence_scholar_api_key']);
      if (syncResult.essence_scholar_api_key) {
        apiKey = syncResult.essence_scholar_api_key;
      }
    } catch (error) {
      console.log('Error accessing chrome.storage.sync:', error);
    }
  }
  
  return apiKey;
}

async function makeApiRequestWithBackend(endpoint, options = {}, backend) {
  if (!backend) {
    throw new Error('No backend provided');
  }
  const url = `${backend.url}${endpoint}`;
  const timeout = backend.url.includes('localhost') 
    ? CONFIG.REQUEST_TIMEOUT 
    : CONFIG.CLOUD_REQUEST_TIMEOUT;
  
  // Get API key for authentication
  const apiKey = await getApiKeyBackground();
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = {
      'Content-Type': 'application/json',
      ...options.headers
    };
    
    // Add Authorization header if API key is available
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers
    });
    clearTimeout(timeoutId);
    
    // Reset failure tracking on successful response
    if (response.ok) {
      ServiceWorkerBackendManager.resetFailureTracking();
    } else {
      // Track failure for non-OK responses
      ServiceWorkerBackendManager.trackBackendFailure(new Error(`HTTP ${response.status}: ${response.statusText}`));
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Track failure for network errors
    ServiceWorkerBackendManager.trackBackendFailure(error);
    
    if (error.name === 'AbortError') {
      // Request timed out
      console.log('⏰ Request timed out');
    } else {
      // Request failed
      console.log('❌ Request failed:', error.message);
    }
    throw error;
  }
}

// Inline ID generation functions for service worker compatibility
async function generateSHA256Hash(text) {
  const encoder = new TextEncoder();
  const data = encoder.encode(text);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 12); // Take first 12 characters like backend
}

// Inline exact copy of shared-id-generator functions
function extractSsrnIdFromUrlInline(url) {
  if (!url) return null;
  
  // Prefer query string: abstractId or abstract_id
  let match = url.match(/[?&]abstractId=(\d+)/i);
  if (match) {
    console.debug('Found abstractId in URL:', match[1]);
    return match[1];
  }
  
  match = url.match(/[?&]abstract_id=(\d+)/i);
  if (match) {
    console.debug('Found abstract_id in URL:', match[1]);
    return match[1];
  }
  
  // Handle abstract= in URL (common SSRN format)
  match = url.match(/\/abstract=(\d+)/i);
  if (match) {
    console.debug('Found /abstract= in URL:', match[1]);
    return match[1];
  }
      
  match = url.match(/[?&]abstract=(\d+)/i);
  if (match) {
    console.debug('Found abstract= in URL:', match[1]);
    return match[1];
  }
  
  console.debug('No SSRN ID found in URL, returning null');
  return null;
}

async function generatePaperIdInline(paperContent) {
  console.log('[BACKGROUND generatePaperIdInline] Called with:', paperContent);
  
  // Try to extract SSRN numeric ID first
  if (paperContent.paperUrl) {
    const url = paperContent.paperUrl;
    console.debug('[BACKGROUND] Attempting to extract ID from URL:', url);
    const extractedId = extractSsrnIdFromUrlInline(url);
    console.debug('[BACKGROUND] Extracted ID:', extractedId);
    
    // If we got a numeric ID (SSRN paper), use it
    if (extractedId && /^\d+$/.test(extractedId)) {
      console.log('[BACKGROUND] Using SSRN ID:', extractedId);
      return extractedId;
    }
    
    // If no SSRN ID found (non-SSRN paper), create a hash-based ID from URL
    if (!extractedId) {
      const urlHash = await generateSHA256Hash(url);
      console.debug('[BACKGROUND] Generated hash-based ID for non-SSRN URL:', urlHash);
      return urlHash;
    }
  }

  // Fallback: hash the whole content to guarantee a deterministic ID
  const identifier = JSON.stringify(paperContent, Object.keys(paperContent).sort()).substring(0, 1000);
  const contentHash = await generateSHA256Hash(identifier);
  console.debug('[BACKGROUND] Generated content-based ID:', contentHash);
  return contentHash;
}

async function generateIdFromUrl(url) {
  console.log('[BACKGROUND generateIdFromUrl] Called with URL:', url);
  return await generatePaperIdInline({ paperUrl: url });
}

// =============================================================================
// ENHANCED: Network-Layer PDF Detection with State Management
// =============================================================================

// Enhanced PDF detection state management
const pdfDetectionState = new Map();

// Improved webRequest listener for PDF detection
if (chrome.webRequest && chrome.webRequest.onHeadersReceived) {
  try {
    chrome.webRequest.onHeadersReceived.addListener(
      details => {
        if (details.type !== 'main_frame') return;
        
        // Check Content-Type header
        const contentTypeHeader = details.responseHeaders?.find(
          h => h.name.toLowerCase() === 'content-type'
        );
        const contentType = contentTypeHeader?.value || '';
        
        // Check Content-Disposition for PDF hints
        const dispositionHeader = details.responseHeaders?.find(
          h => h.name.toLowerCase() === 'content-disposition'
        );
        const disposition = dispositionHeader?.value || '';
        
        // Multiple PDF detection criteria
        const isPDF = 
          contentType.includes('application/pdf') ||
          contentType.includes('application/x-pdf') ||
          disposition.includes('.pdf') ||
          details.url.toLowerCase().endsWith('.pdf');
        
        if (isPDF) {
          console.log('[BG PDF] PDF detected via headers:', {
            url: details.url.substring(0, 100),
            contentType,
            tabId: details.tabId
          });
          
          // Store PDF detection info
          pdfDetectionState.set(details.tabId, {
            isPDF: true,
            url: details.url,
            contentType,
            timestamp: Date.now()
          });
          
          // Notify content script with delay to ensure it's loaded
          setTimeout(() => {
            chrome.tabs.sendMessage(details.tabId, {
              action: 'pdfDetected',
              details: {
                url: details.url,
                contentType,
                method: 'webRequest'
              }
            }).catch(err => {
              console.log('[BG PDF] Could not notify content script:', err.message);
            });
          }, 500);
        }
      },
      { urls: ['<all_urls>'], types: ['main_frame'] },
      ['responseHeaders']
    );
    console.log('[BG PDF] webRequest listener registered successfully');
  } catch (error) {
    console.error('[BG PDF] Failed to register webRequest listener:', error);
  }
} else {
  console.warn('[BG PDF] webRequest API not available, falling back to URL-based detection');
}

// Clean up PDF detection state on tab removal
chrome.tabs.onRemoved.addListener(tabId => {
  pdfDetectionState.delete(tabId);
  try { activeTabs.delete(tabId); } catch (_) {}
  try { chrome.storage.local.remove(`tabResult_${tabId}`); } catch (_) {}
  console.log('[BG PDF] Cleaned up PDF state for tab:', tabId);
});

// Clean up on navigation
if (chrome.webNavigation && chrome.webNavigation.onBeforeNavigate) {
  chrome.webNavigation.onBeforeNavigate.addListener(details => {
    if (details.frameId === 0) {
      pdfDetectionState.delete(details.tabId);
      try { activeTabs.delete(details.tabId); } catch (_) {}
      try { chrome.storage.local.remove(`tabResult_${details.tabId}`); } catch (_) {}
      console.log('[BG PDF] Cleared PDF state on navigation for tab:', details.tabId);
    }
  });
} else if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener(e => {
    if (e.transitionType === 'reload') {
      pdfDetectionState.delete(e.tabId);
      console.log('[BG PDF] Cleared PDF state on reload for tab:', e.tabId);
    }
  });
} else {
  console.warn('[BG PDF] webNavigation API not available');
}

// Simple backend management for background script
const BackendManager = {
  async getCurrentBackend() {
    try {
      // Try to get backend from storage
      const result = await chrome.storage.local.get(['currentBackend']);
      if (result.currentBackend && result.currentBackend.url) {
        return result.currentBackend;
      }
      
      // Fallback to default backend if available
      if (typeof CONFIG !== 'undefined' && CONFIG.CURRENT_BACKEND) {
        return CONFIG.CURRENT_BACKEND;
      }
      
      return null;
    } catch (error) {
      console.error('[BackendManager] Error getting backend:', error);
      return null;
    }
  }
};

// Helper function to make API requests with backend
async function makeApiRequestWithBackend(endpoint, options, backend) {
  if (!backend || !backend.url) {
    throw new Error('No valid backend available');
  }
  
  const url = endpoint.startsWith('http') ? endpoint : `${backend.url}${endpoint}`;
  
  // Get API key for authentication
  const apiKey = await getApiKeyBackground();
  
  const headers = {
    'Content-Type': 'application/json',
    ...options.headers
  };
  
  // Add Authorization header if API key is available
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers
  });
  
  return response;
}

// Function to handle PDF analysis
async function handlePDFAnalysis(request, sender, sendResponse) {
  const tabId = request.tabId || sender.tab?.id;
  
  try {
    console.log('[BG PDF Analysis] Starting analysis for tab:', tabId);
    
    // Get PDF info
    const pdfInfo = pdfDetectionState.get(tabId);
    const tabState = activeTabs.get(tabId);
    
    if (!pdfInfo && !tabState?.pdfInfo) {
      throw new Error('No PDF information available for this tab');
    }
    
    const url = request.url || pdfInfo?.url || tabState?.pdfInfo?.url;
    const paperId = await generateIdFromUrl(url);
    
    // Check if already analyzing
    if (analysisInProgress.has(tabId)) {
      sendResponse({ 
        success: false, 
        error: 'Analysis already in progress' 
      });
      return;
    }
    
    analysisInProgress.add(tabId);
    
    // Get settings
    const settings = await chrome.storage.local.get(['llmSettings', 'userSettings']);
    const llmSettings = settings.llmSettings || { model: 'gemini-3-flash-preview' };
    const userSettings = settings.userSettings || {};
    
    // Get backend
          const backend = await ServiceWorkerBackendManager.getCurrentBackend();
    if (!backend) {
      throw new Error('No backend available');
    }
    
    // Prepare payload
    const payload = {
      content: {
        paperUrl: url,
        paperId: paperId
      },
      model: llmSettings.model,
      user_scholar_url: userSettings.googleScholarUrl || '',
      research_interests: userSettings.researchInterests || ''
    };
    
    // Add PDF content if available
    if (request.fileContent) {
      payload.file_content = request.fileContent;
    } else if (tabState?.pdfInfo?.content) {
      payload.file_content = tabState.pdfInfo.content;
    }

    // Background fallback: try downloading the PDF bytes here if we still don't have content
    if (!payload.file_content) {
      try {
        const b64 = await fetchPdfBytesToBase64(url);
        if (b64 && b64.length > 0) {
          payload.file_content = b64;
          console.log('[BG PDF] Attached downloaded PDF bytes to payload');
        }
      } catch (downloadErr) {
        console.warn('[BG PDF] Could not fetch PDF bytes; backend will try URL:', downloadErr?.message || downloadErr);
      }
    }
    
    // No API keys needed - backend handles all LLM API keys
    
    // Send to backend
    const response = await makeApiRequestWithBackend(CONFIG.ANALYZE_STREAM_ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(payload)
    }, backend);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend error: ${errorText}`);
    }
    
    const result = await response.json();
    
    // Store result
    const storageKey = `analysis_${paperId}`;
    await chrome.storage.local.set({
      [storageKey]: {
        timestamp: new Date().toISOString(),
        paperId: paperId,
        data: result,
        url: url
      }
    });
    
    // Clean up
    analysisInProgress.delete(tabId);
    
    // Send success response
    sendResponse({
      success: true,
      paperId: paperId,
      data: result
    });
    
    // Update badge
    chrome.action.setBadgeText({ text: '✓' });
    chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
    
  } catch (error) {
    console.error('[BG PDF Analysis] Error:', error);
    analysisInProgress.delete(tabId);
    
    sendResponse({
      success: false,
      error: error.message
    });
    
    // Update badge
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
  }
}

// Helper: fetch PDF bytes in background and return base64
async function fetchPdfBytesToBase64(url) {
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to download PDF: ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const sub = bytes.subarray(i, i + CHUNK);
    bin += String.fromCharCode.apply(null, sub);
  }
  return btoa(bin);
}

// =============================================================================
// Analysis Management (Simplified)
// =============================================================================

// Keep track of active tabs and their states
let activeTabs = new Map();
let analysisInProgress = new Set();
let analysisQueue = [];
let isProcessingQueue = false;
let pdfTabs = new Set(); // Track tabs with PDF content

// Analysis monitoring state
let activeMonitors = new Map();
let monitoringIntervals = new Map();

// Persist per-tab ingest result to both memory and chrome.storage so the popup
// can render the correct state even after the MV3 service worker is evicted
// (which wipes activeTabs). Keyed by tab id.
const TAB_RESULT_PREFIX = 'tabResult_';

async function setTabResult(tabId, patch) {
  if (tabId == null) return;
  const prev = activeTabs.get(tabId) || {};
  const next = { ...prev, ...patch, lastUpdated: Date.now() };
  activeTabs.set(tabId, next);
  try {
    await chrome.storage.local.set({ [`${TAB_RESULT_PREFIX}${tabId}`]: next });
  } catch (_) {}
}

async function getTabResult(tabId) {
  if (tabId == null) return null;
  if (activeTabs.has(tabId)) return activeTabs.get(tabId);
  try {
    const r = await chrome.storage.local.get([`${TAB_RESULT_PREFIX}${tabId}`]);
    return r[`${TAB_RESULT_PREFIX}${tabId}`] || null;
  } catch (_) {
    return null;
  }
}

// Persist monitoring state to chrome.storage
async function persistMonitoringState() {
  const monitoringState = {};
  for (const [paperId, monitorInfo] of activeMonitors.entries()) {
    monitoringState[paperId] = {
      paperId: monitorInfo.paperId,
      tabId: monitorInfo.tabId,
      backend: monitorInfo.backend,
      startTime: monitorInfo.startTime,
      lastLogIndex: monitorInfo.lastLogIndex
    };
  }
  
  try {
    await chrome.storage.local.set({ backgroundMonitoring: monitoringState });
    console.log('[BG] Persisted monitoring state for papers:', Object.keys(monitoringState));
  } catch (error) {
    console.error('[BG] Error persisting monitoring state:', error);
  }
}

// Restore monitoring state from chrome.storage
async function restoreMonitoringState() {
  try {
    const result = await chrome.storage.local.get(['backgroundMonitoring']);
    const monitoringState = result.backgroundMonitoring || {};
    
    console.log('[BG] Restoring monitoring state for papers:', Object.keys(monitoringState));
    
    for (const [paperId, monitorInfo] of Object.entries(monitoringState)) {
      // Check if monitoring should still be active (not older than 15 minutes)
      const ageMinutes = (Date.now() - monitorInfo.startTime) / (1000 * 60);
      if (ageMinutes < 15) {
        console.log('[BG] Restoring monitoring for paper:', paperId, 'age:', ageMinutes, 'minutes');
        
        // Restore monitor info
        activeMonitors.set(paperId, monitorInfo);
        
        // Start interval again
        const intervalId = setInterval(async () => {
          console.log('[BG] Restored interval triggered for paper:', paperId);
          await pollAnalysisStatus(paperId);
        }, 2000);
        
        monitoringIntervals.set(paperId, intervalId);
        console.log('[BG] Restored monitoring for paper:', paperId);
      } else {
        console.log('[BG] Skipping stale monitoring for paper:', paperId, 'age:', ageMinutes, 'minutes');
      }
    }
  } catch (error) {
    console.error('[BG] Error restoring monitoring state:', error);
  }
}

// Call restore on startup
console.log('[BG] Service worker starting up, restoring monitoring state...');
restoreMonitoringState();

// Check if this is first install and show onboarding - only on startup, not on every service worker restart
// This will be handled by chrome.runtime.onInstalled instead

// Log configuration on startup
console.log('Background script: Smart backend detection enabled');
console.log('Background script: Available backends:', Object.keys(CONFIG.BACKENDS));
console.log('Background script: Auto-detect enabled:', CONFIG.AUTO_DETECT_BACKENDS);

// Analysis monitoring functions
async function startAnalysisMonitoring(paperId, tabId, backend) {
  console.log('[BG] Starting analysis monitoring for paper:', paperId, 'tab:', tabId);
  console.log('[BG] Backend for monitoring:', backend.name, backend.url);
  
  // Clear any existing monitor for this paper
  stopAnalysisMonitoring(paperId);
  
  const monitorInfo = {
    paperId,
    tabId,
    backend,
    startTime: Date.now(),
    lastLogIndex: -1
  };
  
  activeMonitors.set(paperId, monitorInfo);
  
  // Start polling every 5 seconds
  const intervalId = setInterval(async () => {
    console.log('[BG] Interval triggered for paper:', paperId);
    
    // Double-check we should still be monitoring
    if (!activeMonitors.has(paperId)) {
      console.log('[BG] Stopping orphaned interval for paper:', paperId);
      clearInterval(intervalId);
      monitoringIntervals.delete(paperId);
      return;
    }
    
    await pollAnalysisStatus(paperId);
  }, 5000);
  
  monitoringIntervals.set(paperId, intervalId);
  
  // Set timeout to stop monitoring after 10 minutes
  setTimeout(() => {
    if (activeMonitors.has(paperId)) {
      console.log('[BG] Analysis monitoring timeout for paper:', paperId);
      stopAnalysisMonitoring(paperId);
    }
  }, 10 * 60 * 1000);
  
  // Persist the new monitoring state
  await persistMonitoringState();
}

async function stopAnalysisMonitoring(paperId) {
  console.log('[BG] Stopping analysis monitoring for paper:', paperId);
  
  const intervalId = monitoringIntervals.get(paperId);
  if (intervalId) {
    clearInterval(intervalId);
    monitoringIntervals.delete(paperId);
  }
  
  activeMonitors.delete(paperId);
  
  // Persist the updated monitoring state
  await persistMonitoringState();
}

async function pollAnalysisStatus(paperId) {
  const monitorInfo = activeMonitors.get(paperId);
  if (!monitorInfo) return;
  
  // Prevent concurrent polling
  if (monitorInfo.polling) return;
  
  monitorInfo.polling = true;
  
  try {
    // Simple check: does paper exist in backend?
    const paperUrl = `${monitorInfo.backend.url}/storage/paper/${encodeURIComponent(paperId)}`;
    const response = await fetch(paperUrl);
    
    if (response.ok) {
      // Paper exists - analysis is complete
      console.log('[BG] Paper exists, analysis completed for paper:', paperId);
      stopAnalysisMonitoring(paperId);
      
      // Notify popup if it's open
      try {
        chrome.runtime.sendMessage({
          action: 'analysisComplete',
          tabId: monitorInfo.tabId,
          paperId: paperId
        });
      } catch (e) {
        console.log('[BG] Could not notify popup (probably closed):', e.message);
      }
      
      return;
    } else if (response.status === 404) {
      console.log('[BG] Paper not found yet, continuing monitoring for paper:', paperId);
      return;
    } else {
      throw new Error(`Paper check failed: ${response.status}`);
    }
    
  } catch (error) {
    console.error('[BG] Error polling analysis status for paper', paperId, ':', error);
  } finally {
    // Clear polling flag
    if (monitorInfo) {
      monitorInfo.polling = false;
    }
  }
}

// Function to get monitoring status for a paper
function getMonitoringStatus(paperId) {
  const monitorInfo = activeMonitors.get(paperId);
  if (!monitorInfo) return null;
  
  return {
    isMonitoring: true,
    startTime: monitorInfo.startTime,
    paperId: monitorInfo.paperId,
    tabId: monitorInfo.tabId
  };
}

// =============================================================================
// Legacy Analysis Functions (Simplified)
// =============================================================================

// Function to add analysis to queue
async function addToAnalysisQueue(tabId, url, priority = 0) {
  console.log(`Background: Adding tab ${tabId} to analysis queue`);
  
  // Check if already in queue
  const existingIndex = analysisQueue.findIndex(item => item.tabId === tabId);
  if (existingIndex !== -1) {
    console.log(`Background: Tab ${tabId} already in queue, updating priority`);
    analysisQueue[existingIndex].priority = priority;
    analysisQueue[existingIndex].timestamp = Date.now();
    return;
  }
  
  // Add to queue
  analysisQueue.push({
    tabId: tabId,
    url: url,
    priority: priority,
    timestamp: Date.now()
  });
  
  // Sort queue by priority
  analysisQueue.sort((a, b) => {
    if (a.priority !== b.priority) {
      return b.priority - a.priority;
    }
    return a.timestamp - b.timestamp;
  });
  
  // Start processing queue if not already processing
  if (!isProcessingQueue) {
    processAnalysisQueue();
  }
}

// Function to process the analysis queue
async function processAnalysisQueue() {
  if (isProcessingQueue || analysisQueue.length === 0 || analysisInProgress.size > 0) {
    return;
  }
  
  isProcessingQueue = true;
  
  try {
    while (analysisQueue.length > 0 && analysisInProgress.size === 0) {
      const nextAnalysis = analysisQueue.shift();
      
      try {
        const tab = await chrome.tabs.get(nextAnalysis.tabId);
        if (!tab) continue;
        
        await triggerPDFAnalysis(nextAnalysis.tabId);
        
        // Wait for this analysis to complete
        while (analysisInProgress.has(nextAnalysis.tabId)) {
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
        
      } catch (error) {
        console.error(`Background: Error processing analysis for tab ${nextAnalysis.tabId}:`, error);
        analysisInProgress.delete(nextAnalysis.tabId);
      }
    }
  } catch (error) {
    console.error('Background: Error in queue processing:', error);
  } finally {
    isProcessingQueue = false;
    
    if (analysisQueue.length > 0 && analysisInProgress.size === 0) {
      setTimeout(() => processAnalysisQueue(), 1000);
    }
  }
}

// Extract SSRN ID from URL (matches backend logic)
async function extractSsrnIdFromUrl(url) {
  if (!url) return null;
  
  console.log('[BACKGROUND extractSsrnIdFromUrl] Called with URL:', url);
  
  try {
    const paperId = await generateIdFromUrl(url);
    console.log('[BACKGROUND extractSsrnIdFromUrl] Generated paper ID:', paperId, 'for URL:', url);
    return paperId;
  } catch (error) {
    console.error('[BACKGROUND extractSsrnIdFromUrl] Error generating paper ID:', error);
    // Fallback to simple SSRN ID extraction
    const match = url.match(/[?&]abstract(?:_?id)?=(\d+)/i);
    const fallbackId = match ? match[1] : url;
    console.log('[BACKGROUND extractSsrnIdFromUrl] Fallback paper ID:', fallbackId);
    return fallbackId;
  }
}

// Function to automatically trigger PDF analysis
async function triggerPDFAnalysis(tabId) {
  let paperUrl = undefined;
  let paperId = undefined;
  try {
    // Check if analysis is already in progress for this tab
    if (analysisInProgress.has(tabId)) {
      console.log(`Analysis already in progress for tab ${tabId}`);
      return;
    }
    
    console.log(`Starting analysis for tab ${tabId}`);
    analysisInProgress.add(tabId);
    
    // Update tab state
    const currentTabState = activeTabs.get(tabId) || {};
    const newTabState = {
      ...currentTabState,
      analysisInProgress: true,
      analysisQueued: false,
      analysisStartTime: Date.now(),
      lastUpdated: Date.now()
    };
    activeTabs.set(tabId, newTabState);
    
    try {
      // Get tab info
      const tab = await chrome.tabs.get(tabId);
      if (!tab || !tab.url) {
        throw new Error('Could not get tab URL');
      }

      let paperContent;
      paperUrl = tab.url;

      // For PDF files detected by network layer, we may not need content extraction
      let isPDF = pdfTabs.has(tabId);
      
      if (!isPDF) {
        // Try to get content from legacy content script if available
        try {
          const response = await chrome.tabs.sendMessage(tabId, { action: 'getPaperContent' });
          if (!response || response.error) {
            throw new Error(response?.error || 'Failed to get paper content');
          }
          paperContent = response.content;
          paperUrl = response.content.paperUrl;
        } catch (connectionError) {
          console.error(`Background: Connection error for tab ${tabId}:`, connectionError);
          
          // If we can't connect to content script, try to extract basic info from tab
          if (tab.url.includes('ssrn.com')) {
            paperId = await extractSsrnIdFromUrl(tab.url);
            if (paperId) {
              paperContent = {
                paperUrl: tab.url,
                paperId: paperId,
                title: 'SSRN Paper',
                abstract: 'Content extracted from URL',
                paperContent: 'Paper content not available - analyzed from URL only'
              };
              paperUrl = tab.url;
              console.log(`Background: Using fallback content for SSRN paper ${paperId}`);
            } else {
              throw new Error('Could not extract paper information and content script connection failed');
            }
          } else {
            throw new Error(`Content script connection failed: ${connectionError.message}`);
          }
        }
      }
      
      // Extract paper ID (if not already set via fallback)
      if (!paperId) {
        paperId = await extractSsrnIdFromUrl(paperUrl);
      }
      
      if (!paperId) {
        throw new Error('Could not extract paper ID from URL');
      }
      
      // Set analysis status to in progress
      try {
        const STATUS_KEY = 'analysisStatus';
        const now = new Date().toISOString();
        const storage = await chrome.storage.local.get([STATUS_KEY]);
        const allStatus = storage[STATUS_KEY] || {};
        allStatus[paperId] = {
          status: 'in_progress',
          updatedAt: now,
          startedAt: now,
          paperId: paperId
        };
        await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
      } catch (statusError) {
        console.error('Error setting analysis status:', statusError);
      }

      // Show badge indicator
      chrome.action.setBadgeText({ text: '...' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

      // Get LLM settings and user settings with better error handling
      let llmSettings, userSettings;
      try {
        const settingsResult = await chrome.storage.local.get(['llmSettings', 'userSettings']);
        llmSettings = settingsResult.llmSettings || { model: 'gemini' };
        userSettings = settingsResult.userSettings || {};
        
        console.log('[BG] Retrieved settings for analysis:', {
          hasLlmSettings: !!settingsResult.llmSettings,
          hasUserSettings: !!settingsResult.userSettings,
          userScholarUrl: userSettings.googleScholarUrl?.substring(0, 50) + '...',
          researchInterests: userSettings.researchInterests ? 'present' : 'empty'
        });
      } catch (settingsError) {
        console.error('[BG] Error retrieving settings, using defaults:', settingsError);
        llmSettings = { model: 'gemini' };
        userSettings = {};
      }
      
      const userScholarUrl = userSettings.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en';
      const researchInterests = userSettings.researchInterests || '';
      
      // Use global backend
      let backend = await ServiceWorkerBackendManager.getCurrentBackend();
      
      // Make API request to backend
      let serverResponse;
      try {
        serverResponse = await makeApiRequestWithBackend(CONFIG.ANALYZE_STREAM_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            content: paperContent || { paperUrl },
            model: llmSettings.model,
            user_scholar_url: userScholarUrl,
            research_interests: researchInterests
            // API keys managed by backend
          })
        }, backend);
      } catch (apiError) {
        console.error(`API request failed for tab ${tabId} on backend ${backend?.name}:`, apiError);
        backend = await ServiceWorkerBackendManager.getCurrentBackend();
        // Retry once with new backend
        serverResponse = await makeApiRequestWithBackend(CONFIG.ANALYZE_STREAM_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            content: paperContent || { paperUrl },
            model: llmSettings.model,
            user_scholar_url: userScholarUrl,
            research_interests: researchInterests
            // API keys managed by backend
          })
        }, backend);
      }

      if (!serverResponse.ok) {
        const errorData = await serverResponse.json();
        throw new Error(errorData.error || `Backend error: ${serverResponse.status}`);
      }

      // Handle SSE stream properly
      const reader = serverResponse.body.getReader();
      const decoder = new TextDecoder();
      let data = {};
      
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const eventData = JSON.parse(line.substring(6));
              // Merge event data into our final data object
              data = { ...data, ...eventData };
              
              // Update paperId if returned
              if (eventData.paper_id) {
                paperId = eventData.paper_id;
              }
              
              // Log progress
              if (eventData.status && eventData.message) {
                console.log(`[BG] Analysis progress: ${eventData.status} - ${eventData.message}`);
              }
            } catch (e) {}
          }
        }
      }

      console.log('Background: Analysis completed successfully, storing results for paper:', paperId);

      // Generate consistent analysis_id
      const generatedAnalysisId = await generateAnalysisId(paperId, userScholarUrl);

      // Store the analysis result
      const storageKey = `analysis_${paperId}`;
      const analysisResult = {
        timestamp: new Date().toISOString(),
        paperId: paperId,
        analysisId: data.analysis_id || generatedAnalysisId,
        content: paperContent || { 
          paperUrl: paperUrl,
          paperId: paperId,
          title: 'Paper from Backend Analysis',
          abstract: 'Analyzed via background process',
          paperContent: 'Content processed by backend'
        },
        summary: data.summary || '',
        data: data,
        autoAnalyzed: true
      };

      const analysisStorageData = {};
      analysisStorageData[storageKey] = analysisResult;
      await chrome.storage.local.set(analysisStorageData);

      // Set analysis status to complete
      try {
        const STATUS_KEY = 'analysisStatus';
        const now = new Date().toISOString();
        const storage = await chrome.storage.local.get([STATUS_KEY]);
        const allStatus = storage[STATUS_KEY] || {};
        allStatus[paperId] = {
          status: 'complete',
          updatedAt: now,
          finishedAt: now,
          paperId: paperId
        };
        await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
      } catch (statusError) {
        console.error('Error setting analysis status:', statusError);
      }

      // Update badge
      chrome.action.setBadgeText({ text: '✓' });
      chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

      // Notify popup - Send BOTH for compatibility
      try {
        chrome.runtime.sendMessage({
          action: 'pdfReady',
          tabId: tabId,
          paperId: paperId,
          pdf: { url: paperUrl, paperId: paperId }
        }).catch(() => {});

        chrome.runtime.sendMessage({
          action: 'analysisComplete',
          paperId: paperId,
          data: data
        }).catch(() => {
          console.log('Popup not available for completion notification');
        });
      } catch (error) {
        // Ignore if popup is not open
      }

    } finally {
      // Always clean up the analysis state
      analysisInProgress.delete(tabId);
      
      // Update tab state
      const finalState = activeTabs.get(tabId) || {};
      finalState.analysisInProgress = false;
      finalState.analysisQueued = false;
      finalState.pdfReady = true;
      finalState.paperId = paperId;
      finalState.lastUpdated = Date.now();
      activeTabs.set(tabId, finalState);
      
      // Process next item in queue if any
      if (analysisQueue.length > 0) {
        setTimeout(processAnalysisQueue, 1000);
      }
    }
    
  } catch (error) {
    console.error(`Background: Error in analysis for tab ${tabId}:`, error);
    
    // Notify popup of error
    try {
      chrome.runtime.sendMessage({
        action: 'analysisError',
        tabId: tabId,
        error: error.message
      }).catch(() => {});
    } catch (e) {}

    // Set analysis status to error
    try {
      const STATUS_KEY = 'analysisStatus';
      const now = new Date().toISOString();
      const storage = await chrome.storage.local.get([STATUS_KEY]);
      const allStatus = storage[STATUS_KEY] || {};
      if (paperUrl) {
        const paperId = await extractSsrnIdFromUrl(paperUrl);
        if (paperId) {
          allStatus[paperId] = {
            status: 'error',
            updatedAt: now,
            finishedAt: now,
            paperId: paperId,
            errorMessage: error.message
          };
          await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
        }
      }
    } catch (statusError) {
      console.error('Error setting error status:', statusError);
    }
    
    // Show error in badge
    chrome.action.setBadgeText({ text: '!' });
    chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
    
    // Clean up analysis state
    analysisInProgress.delete(tabId);
    
    // Update tab state to show error
    const errorState = activeTabs.get(tabId) || {};
    errorState.analysisInProgress = false;
    errorState.analysisQueued = false;
    errorState.analysisError = error.message;
    errorState.lastUpdated = Date.now();
    activeTabs.set(tabId, errorState);
    
    // Process next item in queue if any
    if (analysisQueue.length > 0) {
      setTimeout(processAnalysisQueue, 1000);
    }
  }
}

// =============================================================================
// Tab Management
// =============================================================================

// Listen for tab updates
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Handle tab refresh/navigation start
  if (changeInfo.status === 'loading') {
    console.log('Background: Tab starting to load/refresh:', tabId, tab.url);
    
    // Clean up states for this tab when it refreshes
    if (tab.url) {
      const paperId = extractSsrnIdFromUrlInline(tab.url);
      if (paperId) {
        const analyzingKey = `analyzing_${tabId}_${paperId}`;
        chrome.storage.local.remove(analyzingKey).then(() => {
          console.log('Background: Cleared analyzing state on tab refresh:', analyzingKey);
        }).catch(err => {
          console.error('Background: Error clearing analyzing state:', err);
        });
        
        // Stop any active monitoring for this paper
        stopAnalysisMonitoring(paperId);
      }
    }
    
    // Remove from analysis progress tracking
    analysisInProgress.delete(tabId);
    pdfTabs.delete(tabId); // Clear PDF detection flag
    
    // Update tab state
    const currentState = activeTabs.get(tabId) || {};
    activeTabs.set(tabId, {
      ...currentState,
      analysisInProgress: false,
      analysisQueued: false,
      lastUpdated: Date.now()
    });
  }
  
  if (changeInfo.status === 'complete') {
    // Mark the tab as active if it might be relevant
    const mightBeRelevant = tab.url && (
      tab.url.includes('ssrn.com') ||
      tab.url.startsWith('file:///') ||
      tab.url.toLowerCase().includes('.pdf') ||
      tab.url.includes('pdf.') ||
      tab.url.includes('/pdf/') ||
      tab.url.includes('arxiv.org') ||
      tab.url.includes('researchgate.net') ||
      tab.url.includes('nature.com') ||
      tab.url.includes('springer.com') ||
      tab.url.includes('wiley.com')
    );
    
    if (mightBeRelevant) {
      const currentState = activeTabs.get(tabId) || {};
      activeTabs.set(tabId, {
        ...currentState,
        url: tab.url,
        lastUpdated: Date.now()
      });
    }
  }
});

// Listen for tab activation
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (tab.url && (
      tab.url.includes('ssrn.com') ||
      tab.url.startsWith('file:///') ||
      tab.url.toLowerCase().includes('.pdf') ||
      tab.url.includes('pdf.') ||
      tab.url.includes('/pdf/') ||
      tab.url.includes('arxiv.org') ||
      tab.url.includes('researchgate.net') ||
      tab.url.includes('nature.com') ||
      tab.url.includes('springer.com') ||
      tab.url.includes('wiley.com')
    )) {
      // Ensure the tab is in activeTabs
      const currentState = activeTabs.get(activeInfo.tabId) || {};
      activeTabs.set(activeInfo.tabId, {
        ...currentState,
        url: tab.url,
        lastUpdated: Date.now()
      });
    }
  } catch (error) {
    console.error('Error handling tab activation:', error);
  }
});

// Listen for tab removal
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const tabState = activeTabs.get(tabId);
  const tabUrl = tabState?.url;
  
  activeTabs.delete(tabId);
  analysisInProgress.delete(tabId);
  pdfTabs.delete(tabId);
  
  // Remove from analysis queue
  const queueIndex = analysisQueue.findIndex(item => item.tabId === tabId);
  if (queueIndex !== -1) {
    analysisQueue.splice(queueIndex, 1);
  }
  
  // Clean up analysis results for this tab if it was closed
  if (tabUrl) {
    try {
      const existingResults = await chrome.storage.local.get(['analysisResults']);
      const allResults = existingResults.analysisResults || {};
      
      if (allResults[tabUrl]) {
        delete allResults[tabUrl];
        await chrome.storage.local.set({ analysisResults: allResults });
      }
      
      const existingAuthorResults = await chrome.storage.local.get(['authorAnalysisResults']);
      const allAuthorResults = existingAuthorResults.authorAnalysisResults || {};
      
      if (allAuthorResults[tabUrl]) {
        delete allAuthorResults[tabUrl];
        await chrome.storage.local.set({ authorAnalysisResults: allAuthorResults });
      }
    } catch (error) {
      console.error('Background: Error cleaning up analysis results for closed tab:', error);
    }
  }
});

// =============================================================================
// Message Handling
// =============================================================================

// Listen for messages from popup and content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Pending download-import consent (popup approval surface)
  if (request.action === 'getPendingImports') {
    _getPendingImports().then(pending => sendResponse({ pending }));
    return true;
  }
  if (request.action === 'resolvePendingImport') {
    _resolvePendingImport(request.downloadId, !!request.accept).then(sendResponse);
    return true;
  }
  // The web app's "Download & import" — consent for ONE paper, before the fact.
  if (request.action === 'armCapture') {
    _armCapture(request.ssrn_id, request.title, request.doi).then(ok => sendResponse({ armed: ok }));
    return true;
  }
  // "Read these SSRN pages in my browser" — the app's own button. Arms exactly
  // the journals it names and opens them; ssrn-browse.js does the rest.
  if (request.action === 'armBrowse') {
    _armBrowse(request.targets).then(sendResponse);
    return true;
  }
  if (request.action === 'browseArmedFor') {
    _browseArmedFor(request.url).then(sendResponse);
    return true;
  }
  if (request.action === 'browseCapture') {
    _browseCapture(request, sender).then(sendResponse);
    return true;
  }
  // Is this extension ready to import anything? Installed is not enough: the
  // capture POSTs with an API KEY the reader pastes in during onboarding, and
  // without one the download is captured and then rejected. The app asks before
  // it sends anyone to SSRN, so it can say which of the two is missing.
  if (request.action === 'captureReadiness') {
    (async () => {
      let key = null;
      let mode = 'ask';
      // getApiKey() lives in config.js, which the service worker does not
      // import; this file has its own reader.
      try { key = await getApiKeyBackground(); } catch (_) { key = null; }
      try { mode = await _downloadCaptureMode(); } catch (_) { mode = 'ask'; }
      let ssrnEnabled = true;
      try {
        const prefs = await _enabledCaptureSources();
        ssrnEnabled = prefs.ssrn !== false;
      } catch (_) { /* missing key means enabled */ }
      // The capture reads the finished download OFF DISK (SSRN's Delivery.cfm
      // links are single-use, so re-fetching returns 403). That needs "Allow
      // access to file URLs", which is OFF by default and cannot be granted
      // programmatically — so the app has to be able to say so.
      let fileAccess = true;
      try {
        fileAccess = await chrome.extension.isAllowedFileSchemeAccess();
      } catch (_) { fileAccess = true; }
      // Which server it will post to. A capture that answers 404 is almost always
      // this: the shipped extension targets production, and a route that only
      // exists on nightly cannot be found there. Without this the app can only
      // report the status code.
      let backendUrl = '';
      try {
        const b = await ServiceWorkerBackendManager.getCurrentBackend();
        backendUrl = (b && b.url) || '';
      } catch (_) { /* leave it blank rather than fail the handshake */ }
      sendResponse({
        version: chrome.runtime.getManifest().version,
        signedIn: Boolean(key),
        captureMode: mode,
        ssrnEnabled,
        fileAccess,
        backendUrl,
      });
    })();
    return true;
  }

  // Add monitoring control handlers
  if (request.action === 'startMonitoring') {
    const { paperId, tabId, backend } = request;
    console.log('[BG] Starting monitoring for paper:', paperId, 'tab:', tabId);
    startAnalysisMonitoring(paperId, tabId, backend);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'stopMonitoring') {
    const { paperId } = request;
    console.log('[BG] Stopping monitoring for paper:', paperId);
    stopAnalysisMonitoring(paperId);
    sendResponse({ success: true });
    return true;
  }

  if (request.action === 'getMonitoringStatus') {
    const { paperId } = request;
    const status = getMonitoringStatus(paperId);
    sendResponse({ status });
    return true;
  }

  if (request.action === 'analysisStarted') {
    // Message sent by popup.js when user clicks the Analyze button
    const tabId = request.tabId;
    const url = request.url;
    console.log('[BG] analysisStarted message received for tab', tabId, 'url', url);
    try {
      if (analysisInProgress.has(tabId)) {
        console.log(`[BG] Analysis already in progress for tab ${tabId}`);
        sendResponse({ success: true, inProgress: true });
        return true;
      }

      // Show badge indicator
      chrome.action.setBadgeText({ text: '...' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });

      // Queue the analysis
      addToAnalysisQueue(tabId, url || null, 1);
      sendResponse({ success: true, queued: true });
    } catch (error) {
      console.error('[BG] Error queuing analysis from analysisStarted:', error);
      sendResponse({ error: error.message || 'Failed to queue analysis' });
    }
    return true;
  }

  // Enhanced PDF message handlers
  
  // Check PDF status for a tab
  if (request.action === 'checkPDFStatus') {
    const tabId = request.tabId || sender.tab?.id;
    const pdfInfo = pdfDetectionState.get(tabId);

    // Read persisted tab result so a reopened popup (or an evicted SW) still
    // reflects a completed/in-progress import.
    (async () => {
      const tabState = (await getTabResult(tabId)) || {};
      if (pdfInfo) {
        sendResponse({
          isPDF: true,
          url: pdfInfo.url,
          contentType: pdfInfo.contentType,
          method: 'background-cache',
          pdfReady: tabState.pdfReady || false,
          paperId: tabState.paperId || null,
          analysisInProgress: tabState.analysisInProgress || false,
          analysisError: tabState.analysisError || null
        });
      } else {
        sendResponse({
          isPDF: false,
          analysisInProgress: tabState.analysisInProgress || false,
          analysisError: tabState.analysisError || null,
          pdfReady: tabState.pdfReady || false,
          paperId: tabState.paperId || null
        });
      }
    })();
    return true;
  }
  
  // Get PDF content from collector
  if (request.action === 'getPDFFromCollector') {
    const tabId = request.tabId;
    const tabState = activeTabs.get(tabId);
    
    if (tabState?.pdfInfo?.content) {
      sendResponse({
        success: true,
        content: tabState.pdfInfo.content,
        size: tabState.pdfInfo.size,
        method: 'pdf-collector'
      });
    } else {
      sendResponse({ success: false, error: 'No PDF content available' });
    }
    return true;
  }
  
  // Store PDF content from collector
  if (request.action === 'storePDFContent' && sender.tab) {
    const tabId = sender.tab.id;
    const tabState = activeTabs.get(tabId) || {};
    
    tabState.pdfInfo = {
      content: request.content,
      size: request.size,
      url: request.url,
      timestamp: Date.now()
    };
    
    activeTabs.set(tabId, tabState);
    sendResponse({ success: true });
    return true;
  }
  
  // Enhanced manual analysis with PDF support
  if (request.action === 'analyzePDF') {
    // Handle PDF analysis request
    try {
      const tabId = sender.tab?.id;
      if (!tabId) {
        sendResponse({ error: 'No tab context available' });
        return true;
      }
      
      if (analysisInProgress.has(tabId)) {
        console.log(`PDF analysis already in progress for tab ${tabId}`);
        sendResponse({ success: true, inProgress: true });
        return true;
      }
      
      // Show badge indicator
      chrome.action.setBadgeText({ text: '...' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
      
      // Start the analysis
      addToAnalysisQueue(tabId, sender.tab.url);
      sendResponse({ success: true, queued: true });
    } catch (error) {
      console.error('Error starting PDF analysis:', error);
      sendResponse({ error: error.message });
    }
    return true;
  }
  
  // Handle messages from PDF collector (legacy support)
  if (request.status === 'ready' && request.pdf) {
    console.log('[BG] PDF collector reported ready:', request.pdf, 'paperId:', request.paperId);

    if (sender.tab) {
      const tabState = activeTabs.get(sender.tab.id) || {};
      tabState.pdfReady = true;
      tabState.pdfInfo = request.pdf;
      tabState.paperId = request.paperId || null;
      tabState.lastUpdated = Date.now();
      activeTabs.set(sender.tab.id, tabState);

      try {
        chrome.runtime.sendMessage({
          action: 'pdfReady',
          tabId: sender.tab.id,
          paperId: request.paperId || null,
          pdf: request.pdf
        });
      } catch (e) {
        // Popup might not be open
      }
    }
    return true;
  }

  if (request.action === 'proxyAnalyzeStream' || request.action === 'proxyIngest') {
    let { file_content, url, source, pdf_url, doi, title } = request;
    // sender.tab is set when the message comes from the content-script collector;
    // popup-initiated (URL) imports pass request.tabId explicitly.
    const tabId = sender.tab?.id ?? request.tabId ?? null;

    (async () => {
      try {
        console.log('[BG Ingest] Starting lightweight ingest for:', url);

        // If we don't have bytes and it's a local file, try fetching here in the
        // background — service workers read file:// more reliably than content scripts.
        if (!file_content && url && url.startsWith('file://')) {
          try {
            file_content = await fetchPdfBytesToBase64(url);
            console.log('[BG Ingest] Background file fetch ok, size:', file_content.length);
          } catch (fetchErr) {
            throw new Error('Could not read local file. Enable "Allow access to file URLs" in chrome://extensions and reload the page.');
          }
        }

        // Mark this tab as importing so a reopened popup shows progress.
        if (tabId != null) await setTabResult(tabId, { analysisInProgress: true, pdfReady: false, paperId: null, url });

        const backend = await ServiceWorkerBackendManager.getCurrentBackend();

        // Lightweight ingest: returns a paper_id fast; full OCR continues server-side.
        const response = await makeApiRequestWithBackend(CONFIG.INGEST_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            file_content: file_content || null,
            url: url || null,
            pdf_url: pdf_url || null,
            doi: doi || null,
            title: title || null,
            source: source || 'browser_extension'
          })
        }, backend);

        if (!response.ok) {
          let errorText = '';
          try { errorText = await response.text(); } catch (_) {}
          console.error('[BG Ingest] Backend error:', response.status, errorText);
          if (tabId != null) await setTabResult(tabId, { analysisInProgress: false, analysisError: `Backend error ${response.status}` });
          if (tabId != null) chrome.runtime.sendMessage({ action: 'analysisError', tabId, error: `Backend error ${response.status}` }).catch(() => {});
          sendResponse({ success: false, error: `Backend error ${response.status}` });
          return;
        }

        const result = await response.json();
        const paperId = result.paper_id || null;
        console.log('[BG Ingest] Ingest complete, paperId:', paperId, 'status:', result.status);

        // Persist result so the popup can complete even if it was closed/reopened.
        if (tabId != null) {
          await setTabResult(tabId, {
            analysisInProgress: false,
            pdfReady: true,
            paperId,
            url,
            title: result.title || null
          });
        }

        // Broadcast the contract the popup waits for.
        chrome.runtime.sendMessage({
          action: 'pdfReady',
          tabId,
          paperId,
          pdf: { url, paperId }
        }).catch(() => {});

        chrome.action.setBadgeText({ text: '✓' });
        chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });

        sendResponse({ success: true, paperId });
      } catch (error) {
        const errorMsg = error.message || error.toString() || 'Unknown background error';
        console.error('[BG Ingest] Error:', errorMsg);
        if (tabId != null) await setTabResult(tabId, { analysisInProgress: false, analysisError: errorMsg });
        if (tabId != null) chrome.runtime.sendMessage({ action: 'analysisError', tabId, error: errorMsg }).catch(() => {});
        sendResponse({ success: false, error: errorMsg });
      }
    })();
    return true;
  }

  if (request.action === 'triggerPDFAnalysis') {
    const tabId = request.tabId || sender.tab?.id;
    if (tabId) {
      triggerPDFAnalysis(tabId).catch(err => {
        console.error('[BG] Error from triggerPDFAnalysis message:', err);
      });
      sendResponse({ success: true, queued: true });
    } else {
      sendResponse({ error: 'No tabId provided' });
    }
    return true;
  }

  if (request.action === 'pdfDetected' && sender.tab) {
    // Forward from content script/popup if needed, but usually background handles this via webRequest
    console.log('[BG] pdfDetected message from tab', sender.tab.id, request.details);
    // You could trigger analysis here if not already started
    return true;
  }

  // Existing sender.tab guard for other messages
  if (!sender.tab && request.action !== 'analysisStarted' && request.action !== 'startMonitoring' && request.action !== 'stopMonitoring' && request.action !== 'getMonitoringStatus') {
    console.warn('Message received without tab context:', request);
    sendResponse({ error: 'No tab context available' });
    return true;
  }

  const tabId = sender.tab?.id;
  
  if (request.action === 'updateTabState') {
    activeTabs.set(tabId, {
      ...activeTabs.get(tabId),
      ...request.state,
      lastUpdated: Date.now()
    });
    sendResponse({ success: true });
  } else if (request.action === 'getTabState') {
    sendResponse({ state: activeTabs.get(tabId) });
  } else if (request.action === 'manualAnalyze') {
    // Handle manual analysis request
    try {
      if (analysisInProgress.has(tabId)) {
        console.log(`Analysis already in progress for tab ${tabId}`);
        sendResponse({ success: true, inProgress: true });
        return true;
      }
      
      // Show badge indicator
      chrome.action.setBadgeText({ text: '...' });
      chrome.action.setBadgeBackgroundColor({ color: '#FF9800' });
      
      // Start the analysis
      addToAnalysisQueue(tabId, sender.tab.url);
      sendResponse({ success: true, queued: true });
    } catch (error) {
      console.error('Error starting manual analysis:', error);
      sendResponse({ error: error.message });
    }
  } else if (request.action === 'ping') {
    sendResponse({ status: 'ok', timestamp: Date.now() });
  } else if (request.action === 'testPaperId') {
    // Test paper ID generation
    (async () => {
      try {
        const paperId = await extractSsrnIdFromUrl(request.url);
        sendResponse({ success: true, paperId: paperId, url: request.url });
      } catch (error) {
        sendResponse({ success: false, error: error.message });
      }
    })();
  } else if (request.action === 'testBackend') {
    // Test backend detection
    (async () => {
      try {
        const backend = await ServiceWorkerBackendManager.getCurrentBackend();
        sendResponse({ 
          success: true, 
          backendAvailable: !!backend,
          backendUrl: backend?.url || null,
          status: backend ? 'Available' : 'No healthy backend found'
        });
      } catch (error) {
        sendResponse({ 
          success: false, 
          error: error.message,
          backendAvailable: false 
        });
      }
    })();
  } else {
    console.log('Unknown message action:', request.action);
    sendResponse({ error: 'Unknown action' });
  }
  return true;
});

// =============================================================================
// Service Worker Lifecycle
// =============================================================================

// Keep the service worker alive
chrome.runtime.onConnect.addListener((port) => {
  port.onDisconnect.addListener(() => {
    // Clean up any resources if needed
  });
});

// Listen for extension installation
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('[BG] Extension installed, checking for onboarding...');
    
    // Wait a moment for storage to be ready
    setTimeout(async () => {
      await checkFirstInstall();
    }, 1000);
  }
}); 

// Function to generate analysis_id consistently with backend
async function generateAnalysisId(paperId, userScholarUrl) {
  const combined = `${paperId}_${userScholarUrl}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(combined);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex.substring(0, 32);
}

// Check if this is first install and show onboarding
async function checkFirstInstall() {
  try {
    const result = await chrome.storage.local.get([
      'onboardingCompleted', 
      'onboardingShown', 
      'userSettings', 
      'llmSettings'
    ]);
    
    // Be more conservative - only show onboarding if NO settings exist at all
    // This prevents overwriting existing user configurations
    const hasAnySettings = result.onboardingCompleted || 
                          result.onboardingShown || 
                          result.userSettings || 
                          result.llmSettings;
    
    if (!hasAnySettings) {
      console.log('[BG] Fresh installation detected (no settings found), showing onboarding...');
      
      // Mark onboarding as shown immediately to prevent duplicate tabs
      await chrome.storage.local.set({ onboardingShown: true });
      
      // Open onboarding page in a new tab
      const onboardingUrl = chrome.runtime.getURL('onboarding.html');
      await chrome.tabs.create({ url: onboardingUrl });
    } else {
      console.log('[BG] Existing installation detected, skipping onboarding');
      console.log('[BG] Found settings:', {
        onboardingCompleted: !!result.onboardingCompleted,
        onboardingShown: !!result.onboardingShown,
        userSettings: !!result.userSettings,
        llmSettings: !!result.llmSettings
      });
    }
  } catch (error) {
    console.error('[BG] Error checking first install:', error);
  }
}

console.log('[BG] New PDF detection system loaded - using webRequest API for network-layer detection');

// ─── Capture PDFs the user DOWNLOADS, not only ones that render in a tab ──────
// pdf-collector.js is a content script, so it can only see a PDF that renders as a
// page. SSRN's "Download This Paper" responds with Content-Disposition: attachment —
// the file goes straight to the download manager, no page is ever rendered, no content
// script runs, and the import silently never happened. That is the reported symptom:
// "the import seems there but it doesn't capture my downloads."
//
// On a completed PDF download we re-fetch the same URL from the service worker. The
// user's cookies apply (credentials: 'include'), so this is their own session on a page
// they already opened — nothing is being worked around.

const _ingestedDownloadIds = new Set();

// ── Consent + scoping for download capture ────────────────────────────────────
// The first version ingested EVERY completed PDF download in the browser — any
// site, any file — and read it straight off the user's disk. That silently
// uploaded personal documents (bank statements, contracts) into the library.
// Field report: "whenever I open my app I see new documents are ingested...
// it doesn't ask me." Two fences now:
//   1. SCOPE — only downloads whose url/referrer is a known academic source are
//      ever considered. A PDF from anywhere else never leaves the machine.
//   2. CONSENT — default mode 'ask' shows a notification with Import / Ignore.
//      'auto' restores one-click capture (academic sources only); 'off' disables.
// The whitelist itself lives in capture-sources.js (shared with the settings
// page). A source the user unticked in settings is treated exactly like a
// non-academic site: the file is never read.
async function _enabledCaptureSources() {
  try {
    const { download_capture_sources } = await chrome.storage.sync.get(['download_capture_sources']);
    return download_capture_sources || {};    // missing key => enabled
  } catch (_) {
    return {};
  }
}

async function _isAcademicSource(item) {
  const key = captureSourceKeyFor(item);
  if (!key) return false;
  const prefs = await _enabledCaptureSources();
  return prefs[key] !== false;
}

// ── Armed captures — a paper the reader asked for IN THE APP ─────────────────
// The app posts { action: 'armCapture', ssrn_id, title } when the reader presses
// "Download & import" on a search hit. That is consent for ONE paper, given
// before the download, in a surface that names it — stronger than the
// after-the-fact notification, so a matching download is imported without
// asking again. It does not widen the whitelist: an armed record is only ever
// consulted for a download the academic-source gate has already admitted.
const _ARMED_TTL_MS = 30 * 60 * 1000;   // a download the reader never made expires

async function _armedCaptures() {
  try {
    const { armed_captures } = await chrome.storage.local.get(['armed_captures']);
    const now = Date.now();
    return (Array.isArray(armed_captures) ? armed_captures : [])
      .filter(a => a && (now - (a.at || 0)) < _ARMED_TTL_MS);
  } catch (_) {
    return [];
  }
}

async function _armCapture(ssrnId, title, doi) {
  const armed = await _armedCaptures();
  const key = String(ssrnId || '').trim();
  const name = String(title || '').trim().slice(0, 300);
  const id = String(doi || '').trim().toLowerCase();
  // Matching is by SSRN id, or by DOI for a paper the reader opens via their
  // library (Settings → Connected access): Wiley/Springer/OUP download URLs
  // carry the DOI; ScienceDirect's do not, so a library download that arrives
  // within minutes of a DOI arm is matched as that arm (see _matchArmed). An arm
  // with neither could never fire, so it is refused rather than stored: the app
  // then knows to leave the reader with the ordinary consent notification.
  if (!key && !id) return false;
  const kept = armed.filter(a => (key ? a.ssrn_id !== key : true) && (id ? a.doi !== id : true));
  kept.push({ ssrn_id: key, doi: id, title: name, at: Date.now() });
  try {
    await chrome.storage.local.set({ armed_captures: kept.slice(-20) });
    console.log('[BG Downloads] armed for', key || name);
    return true;
  } catch (_) {
    return false;
  }
}

/** The armed record this download satisfies, or null. Matched on the SSRN id in
 *  the download url or its referrer — the only identifier both sides share. */
async function _matchArmed(item) {
  const armed = await _armedCaptures();
  if (!armed.length) return null;
  const sid = _abstractIdFromUrl(item.url) || _abstractIdFromUrl(item.referrer);
  if (sid) {
    const bySsrn = armed.find(a => a.ssrn_id && a.ssrn_id === String(sid));
    if (bySsrn) return bySsrn;
  }
  // A library / publisher download: the DOI in the url or referrer names the arm
  // exactly; ScienceDirect (pii urls) carries none, so the ONE armed DOI record
  // still fresh from the last ten minutes is taken to be it — the reader pressed
  // 'open via your library' on that paper minutes ago, and the server then
  // matches on title as well before it files anything.
  const hay = `${item.url || ''} ${item.referrer || ''}`.toLowerCase();
  const byDoi = armed.find(a => a.doi && hay.includes(a.doi));
  if (byDoi) return byDoi;
  const src = typeof captureSourceKeyFor === 'function' ? captureSourceKeyFor(item) : null;
  if (src && src !== 'ssrn') {
    const fresh = armed.filter(a => a.doi && (Date.now() - (a.at || 0)) < 10 * 60 * 1000);
    if (fresh.length === 1) return fresh[0];
  }
  return null;
}

async function _disarm(record) {
  try {
    const armed = await _armedCaptures();
    await chrome.storage.local.set({
      armed_captures: armed.filter(a => a !== record
        && !(record.ssrn_id && a.ssrn_id === record.ssrn_id)
        && !(record.doi && a.doi === record.doi)),
    });
  } catch (_) { /* the TTL clears it anyway */ }
}


async function _downloadCaptureMode() {
  try {
    const { download_capture_mode } = await chrome.storage.sync.get(['download_capture_mode']);
    return ['ask', 'auto', 'off'].includes(download_capture_mode) ? download_capture_mode : 'ask';
  } catch (_) {
    return 'ask';   // storage unavailable → most conservative interactive default
  }
}

function _abstractIdFromUrl(u) {
  const m = /(?:abstract_?id=|ssrn\.)(\d{5,9})/i.exec(u || '');
  return m ? m[1] : null;
}

function _fileUrlFromPath(p) {
  // chrome.downloads gives a native path ("/home/u/x.pdf", "C:\\Users\\u\\x.pdf").
  // Each segment is encoded so spaces and other literals in a paper's filename — very
  // common — do not produce an unfetchable url.
  let path = String(p).replace(/\\/g, '/');
  if (!path.startsWith('/')) path = '/' + path;          // Windows drive letters
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  // Restore the drive-letter colon: Chrome wants file:///C:/… and will not resolve
  // the percent-encoded C%3A that encodeURIComponent produces.
  return 'file://' + encoded.replace(/^\/([A-Za-z])%3A\//, '/$1:/');
}

function _looksLikePdfDownload(item) {
  const url = item.url || '';
  const name = item.filename || '';
  return item.mime === 'application/pdf'
      || /\.pdf(\?|$)/i.test(name)
      || /\.pdf(\?|$)/i.test(url)
      || /Delivery\.cfm/i.test(url);       // SSRN's PDF endpoint has no .pdf suffix
}

/** "I have the file and I am importing it." Matched to the reader's parked
 *  request by the SSRN id in the url; an unmatched download is silently fine
 *  (most downloads were never asked for in the app). */
async function _reportCapture(item) {
  try {
    const sid = _abstractIdFromUrl(item.url) || _abstractIdFromUrl(item.referrer);
    if (!sid) return;                     // nothing the app could be waiting on
    const backend = await ServiceWorkerBackendManager.getCurrentBackend();
    if (!backend) return;
    const name = String(item.filename || '').split(/[\\/]/).pop();
    await makeApiRequestWithBackend('/fetch-queue/capture', {
      method: 'POST',
      body: JSON.stringify({
        url: `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${sid}`,
        filename: name,
      }),
    }, backend);
  } catch (e) {
    console.log('[BG Downloads] capture notice skipped:', e && e.message);
  }
}


// ── Attended browsing — an SSRN page the SERVER is refused ───────────────────
// The app arms one or more eJournal pages when the reader presses "Read it in my
// browser", opens them here, and ssrn-browse.js posts each page back. Nothing is
// read that was not armed: an armed record names ONE journal, expires in 30
// minutes, and is dropped as soon as its page has been captured.
const _BROWSE_TTL_MS = 30 * 60 * 1000;
// Only tabs THIS extension opened may be closed again — a reader who navigated
// to SSRN themselves keeps their tab. Kept in STORAGE, not in a Set: the service
// worker is evicted after ~30s idle, and a reader who takes a minute over
// Cloudflare's check comes back to a worker whose heap has forgotten every tab it
// opened, so nothing was ever closed on the slow path — the one where the promise
// that "it closes itself" matters most.
async function _browseTabIds() {
  try {
    const { browse_tabs } = await chrome.storage.local.get(['browse_tabs']);
    const now = Date.now();
    return (Array.isArray(browse_tabs) ? browse_tabs : [])
      .filter(t => t && (now - (t.at || 0)) < _BROWSE_TTL_MS);
  } catch (_) {
    return [];
  }
}

async function _rememberBrowseTab(tabId) {
  if (tabId == null) return;
  const kept = await _browseTabIds();
  kept.push({ id: tabId, at: Date.now() });
  try { await chrome.storage.local.set({ browse_tabs: kept.slice(-20) }); } catch (_) { /* best effort */ }
}

async function _forgetBrowseTab(tabId) {
  const kept = await _browseTabIds();
  try { await chrome.storage.local.set({ browse_tabs: kept.filter(t => t.id !== tabId) }); }
  catch (_) { /* the TTL clears it anyway */ }
}

function _journalIdFromUrl(u) {
  const m = /[?&]journal_id=(\d+)/i.exec(u || '');
  return m ? m[1] : '';
}

async function _armedBrowse() {
  try {
    const { armed_browse } = await chrome.storage.local.get(['armed_browse']);
    const now = Date.now();
    return (Array.isArray(armed_browse) ? armed_browse : [])
      .filter(a => a && (now - (a.at || 0)) < _BROWSE_TTL_MS);
  } catch (_) {
    return [];
  }
}

async function _setArmedBrowse(list) {
  try { await chrome.storage.local.set({ armed_browse: list.slice(-20) }); return true; }
  catch (_) { return false; }
}

/** Arm a set of pages and open them. Consent for exactly these journals, given
 *  in the app, one click before the pages open. */
async function _armBrowse(targets) {
  const wanted = (Array.isArray(targets) ? targets : [])
    .map(t => ({ url: String((t && t.url) || '').trim(),
                 journal_id: String((t && t.journal_id) || '').trim()
                   || _journalIdFromUrl((t && t.url) || ''),
                 name: String((t && t.name) || '').slice(0, 200) }))
    .filter(t => /^https:\/\/([a-z0-9-]+\.)*ssrn\.com\//i.test(t.url))
    // 8, because that is the product's own hard maximum (MAX_EJOURNALS_PER_SUB in
    // newsletter_routes.py) and the panel offers every stale journal at once. At 6
    // the last two rows of an 8-journal subscription waited on tabs that were
    // never opened.
    .slice(0, 8);
  if (!wanted.length) return { armed: 0, opened: 0 };

  const armed = await _armedBrowse();
  const keep = armed.filter(a => !wanted.some(w => w.journal_id && w.journal_id === a.journal_id));
  await _setArmedBrowse([...keep, ...wanted.map(w => ({ ...w, at: Date.now() }))]);

  let opened = 0;
  for (const w of wanted) {
    try {
      // The FIRST tab is focused: if Cloudflare asks the reader to confirm they
      // are human, they have to see it. The rest load behind it.
      const tab = await chrome.tabs.create({ url: w.url, active: opened === 0 });
      if (tab && tab.id != null) await _rememberBrowseTab(tab.id);
      opened += 1;
    } catch (e) {
      console.log('[BG Browse] could not open', w.url, e && e.message);
    }
  }
  return { armed: wanted.length, opened };
}

async function _browseArmedFor(url) {
  const armed = await _armedBrowse();
  if (!armed.length) return { armed: false };
  const jid = _journalIdFromUrl(url);
  const hit = armed.find(a => (jid && a.journal_id === jid) || (a.url && a.url === url));
  return hit ? { armed: true, journal_id: hit.journal_id || jid, name: hit.name || '' }
             : { armed: false };
}

async function _disarmBrowse(journalId, url) {
  const armed = await _armedBrowse();
  await _setArmedBrowse(armed.filter(a => !((journalId && a.journal_id === journalId)
                                            || (url && a.url === url))));
}

/** Tell every open app tab where this journal got to. Best effort — the app also
 *  polls the backend, which is the source of truth; this only makes the panel
 *  move at the moment it happens. */
function _notifyAppTabs(payload) {
  try {
    chrome.tabs.query({}, (tabs) => {
      void chrome.runtime.lastError;
      const APP_RX = /^https?:\/\/([a-z0-9-]+\.)*essencescholar\.com\/|^https:\/\/essence-scholar-website[\w-]*\.vercel\.app\/|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i;
      (tabs || []).filter(t => t.url && APP_RX.test(t.url)).forEach(t => {
        try { chrome.tabs.sendMessage(t.id, { essenceBrowse: payload }, () => void chrome.runtime.lastError); }
        catch (_) { /* a tab without the bridge */ }
      });
    });
  } catch (_) { /* nothing to notify */ }
}

/** The page came back. Post it to the reader's own backend, which parses it with
 *  the same parser the blocked server fetch used. */
async function _browseCapture(msg, sender) {
  const url = String((msg && msg.url) || '');
  const jid = String((msg && msg.journal_id) || '') || _journalIdFromUrl(url);
  const tabId = sender && sender.tab ? sender.tab.id : null;

  if (msg && msg.challenge) {
    // Two different things arrive here, and telling the reader the wrong one wastes
    // their time: `reason: 'challenge'` means SSRN is asking them to confirm they
    // are human — the tab is brought to the front, because only they can answer it.
    // `reason: 'timeout'` means the page loaded and simply never showed a listing;
    // there is nothing to click, so the tab is left where it is rather than
    // stealing focus (six armed tabs each grabbing focus is its own bug).
    const reason = String((msg && msg.reason) || 'challenge');
    if (reason === 'challenge' && tabId != null) {
      try { await chrome.tabs.update(tabId, { active: true }); } catch (_) { /* gone */ }
    }
    _notifyAppTabs({ journal_id: jid, phase: reason === 'challenge' ? 'challenge' : 'empty', url });
    return { ok: false, challenge: reason === 'challenge' };
  }

  try {
    const backend = await ServiceWorkerBackendManager.getCurrentBackend();
    if (!backend) throw new Error('no backend');
    const res = await makeApiRequestWithBackend('/ssrn/attended-page', {
      method: 'POST',
      body: JSON.stringify({ url, html: String((msg && msg.html) || '') }),
    }, backend);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);

    await _disarmBrowse(jid, url);
    _notifyAppTabs({ journal_id: jid, phase: 'captured', url,
                     parsed: body.parsed || 0, stored: body.stored || 0 });
    // Close only what we opened, and only once it worked — a failed capture
    // leaves the page where the reader can see it.
    const ours = (await _browseTabIds()).some(t => t.id === tabId);
    if (tabId != null && ours && (body.parsed || 0) > 0) {
      await _forgetBrowseTab(tabId);
      try { await chrome.tabs.remove(tabId); } catch (_) { /* already gone */ }
    }
    return { ok: true, parsed: body.parsed || 0, stored: body.stored || 0 };
  } catch (e) {
    console.log('[BG Browse] capture failed:', e && e.message);
    _notifyAppTabs({ journal_id: jid, phase: 'error', url, error: String((e && e.message) || e) });
    return { ok: false, error: String((e && e.message) || e) };
  }
}

chrome.tabs.onRemoved.addListener((tabId) => { void _forgetBrowseTab(tabId); });


async function _ingestDownloadItem(item, armed) {
  try {
        console.log('[BG Downloads] importing PDF download:', item.url);

        // Tell the app FIRST, before the file is even read. Between the reader
        // pressing Download on SSRN and the paper appearing there are three
        // invisible steps — this capture, the upload, and phase-1 extraction —
        // and until now the app's panel said "waiting for your download" through
        // all of them, which reads as nothing having happened (owner, 2026-09-05:
        // "it took some time to appear … would be nice if the extension sends
        // something in the backend … it is imported and needs a little
        // patience"). Best effort and never blocking: a failure here must not
        // cost the import.
        void _reportCapture(item);

        // Read the file we ALREADY have on disk, rather than asking SSRN for it again.
        // SSRN's Delivery.cfm links are single-use: the second request returns 403
        // ("Failed to download PDF: 403"), which is what broke the first version of
        // this. Reading locally also avoids downloading the same paper twice and puts
        // no extra load on SSRN.
        let file_content = null;
        if (item.filename) {
          try {
            file_content = await fetchPdfBytesToBase64(_fileUrlFromPath(item.filename));
            console.log('[BG Downloads] read from disk:', item.filename);
          } catch (e) {
            console.log('[BG Downloads] could not read the downloaded file:', e && e.message);
          }
        }
        // Network fallback for the cases where a local read is not possible (no file
        // access granted, or the file was moved). Harmless when the link still works.
        if (!file_content) {
          try {
            file_content = await fetchPdfBytesToBase64(item.url);
          } catch (e) {
            throw new Error(
              `Could not read the downloaded PDF from disk, and re-downloading it failed ` +
              `(${e && e.message}). Enable "Allow access to file URLs" for this extension ` +
              `in chrome://extensions and download the paper again.`);
          }
        }

        // Send the ABSTRACT page url when we can derive it: the backend files a paper
        // into its newsletter notebook by matching the SSRN id, and a Delivery.cfm url
        // does not always carry one.
        const sid = _abstractIdFromUrl(item.url);
        const abstractUrl = sid
          ? `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${sid}`
          : (item.referrer || item.url);

        // Resolve the backend and pass it: the effective makeApiRequestWithBackend
        // (there are two definitions; the later one wins) REQUIRES the backend as a
        // third argument and returns a raw Response, not parsed JSON. Calling it
        // two-arg produced "No valid backend available" — the whole request never left.
        const backend = await ServiceWorkerBackendManager.getCurrentBackend();
        if (!backend) throw new Error('No backend available (health checks failed)');

        const response = await makeApiRequestWithBackend(CONFIG.INGEST_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({
            file_content,
            url: abstractUrl,
            pdf_url: item.url,
            // From the armed record when the app asked for this paper by name:
            // the server then resolves the parked request by DOI, not by guessing
            // a title out of the PDF.
            title: (armed && armed.title) || null,
            doi: (armed && armed.doi) || null,
            source: 'download_capture',
          }),
        }, backend);
        if (!response.ok) {
          let detail = '';
          try { detail = await response.text(); } catch (_) {}
          throw new Error(`Backend ${response.status}: ${detail.slice(0, 120)}`);
        }
        const res = await response.json();
        const paperId = res && (res.paper_id || res.paperId);
        const filed = res && res.notebook_id;   // matched to a newsletter notebook
        console.log('[BG Downloads] ingested', paperId, '(', backend.name, ') notebook:', filed || '(none)');

        // Three honest states, because "in your library" and "in the notebook you
        // picked it from" are different — and the reported bug was green (looks filed)
        // showing for papers that only reached the library. Green = filed into a
        // notebook. Grey ✓ = in the library but not part of any newsletter issue.
        // Red ! = the ingest itself failed.
        if (filed) {
          chrome.action.setBadgeText({ text: '✓' });
          chrome.action.setBadgeBackgroundColor({ color: '#16a34a' });   // green
        } else if (paperId) {
          chrome.action.setBadgeText({ text: '✓' });
          chrome.action.setBadgeBackgroundColor({ color: '#94a3b8' });   // grey: library only
        } else {
          chrome.action.setBadgeText({ text: '!' });
          chrome.action.setBadgeBackgroundColor({ color: '#F44336' });   // red: failed
        }
        setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
  } catch (e) {
    // Never throw out of the capture path; a failed import must not break the
    // browser's own download handling. But it must not be SILENT either: the red
    // badge above is set inside the try, after response.ok, so a throw skipped it
    // and a brand-new user who never connected an account clicked "Import", got a
    // 401, and saw nothing happen at all. Same badge, same 4s, on this path too.
    console.warn('[BG Downloads] could not ingest download:', e && e.message);
    try {
      chrome.action.setBadgeText({ text: '!' });
      chrome.action.setBadgeBackgroundColor({ color: '#F44336' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 4000);
    } catch (_) { /* no action surface (rare); the console line still stands */ }
    _ingestedDownloadIds.delete(item.id);   // allow a retry on a later attempt
  }
}

// A pending import is recorded in chrome.storage.local AND offered as a
// notification. The notification is the fast path; the badge + popup card are
// the reliable one — desktop notification suppression (common on Linux, or
// Chrome's own settings) must never silently eat a consent request.
const _PENDING_IMPORTS_KEY = 'pending_import_downloads';

async function _getPendingImports() {
  try {
    const o = await chrome.storage.local.get([_PENDING_IMPORTS_KEY]);
    return o[_PENDING_IMPORTS_KEY] || [];
  } catch (_) { return []; }
}

async function _updatePendingBadge() {
  const pending = await _getPendingImports();
  if (pending.length) {
    chrome.action.setBadgeText({ text: String(pending.length) });
    chrome.action.setBadgeBackgroundColor({ color: '#2563eb' });   // blue: awaiting consent
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

async function _addPendingImport(item) {
  const pending = await _getPendingImports();
  if (!pending.some(x => x.id === item.id)) {
    pending.push({
      id: item.id,
      name: (item.filename || item.url || 'document.pdf').split(/[\\/]/).pop(),
      url: item.url || '',
      ts: Date.now(),
    });
    while (pending.length > 10) pending.shift();
    try { await chrome.storage.local.set({ [_PENDING_IMPORTS_KEY]: pending }); } catch (_) {}
  }
  await _updatePendingBadge();
}

async function _resolvePendingImport(downloadId, accept) {
  const pending = await _getPendingImports();
  try {
    await chrome.storage.local.set({
      [_PENDING_IMPORTS_KEY]: pending.filter(x => x.id !== downloadId),
    });
  } catch (_) {}
  try { chrome.notifications.clear(`${_IMPORT_NOTIFICATION_PREFIX}${downloadId}`); } catch (_) {}
  await _updatePendingBadge();
  if (!accept) return { done: true, imported: false };
  const [item] = await chrome.downloads.search({ id: downloadId });
  if (!item) return { done: true, imported: false, error: 'download no longer known to Chrome' };
  await _ingestDownloadItem(item);
  await _updatePendingBadge();   // _ingestDownloadItem sets its own outcome badge
  return { done: true, imported: true };
}

// Restore the badge when the service worker restarts with consents still pending.
_updatePendingBadge();

// Notification ids encode the download id, so a click still resolves after the
// service worker has been restarted in between (no in-memory state needed).
const _IMPORT_NOTIFICATION_PREFIX = 'es-import-';

function _offerImport(item) {
  const name = (item.filename || item.url || 'document.pdf').split(/[\\/]/).pop();
  chrome.notifications.create(`${_IMPORT_NOTIFICATION_PREFIX}${item.id}`, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: 'Import into Essence Scholar?',
    message: name,
    contextMessage: 'Academic PDF downloaded — nothing is uploaded unless you choose Import.',
    buttons: [{ title: 'Import' }, { title: 'Ignore' }],
    priority: 1,
  }, () => void chrome.runtime.lastError);   // notification may be blocked — fine
}

if (chrome.notifications && chrome.notifications.onButtonClicked) {
  chrome.notifications.onButtonClicked.addListener((notifId, buttonIndex) => {
    if (!notifId.startsWith(_IMPORT_NOTIFICATION_PREFIX)) return;
    const downloadId = parseInt(notifId.slice(_IMPORT_NOTIFICATION_PREFIX.length), 10);
    _resolvePendingImport(downloadId, buttonIndex === 0);
  });
}

if (chrome.downloads && chrome.downloads.onChanged) {
  chrome.downloads.onChanged.addListener((delta) => {
    if (!delta || !delta.state || delta.state.current !== 'complete') return;
    if (_ingestedDownloadIds.has(delta.id)) return;      // onChanged can fire repeatedly
    _ingestedDownloadIds.add(delta.id);

    (async () => {
      try {
        const [item] = await chrome.downloads.search({ id: delta.id });
        if (!item || !_looksLikePdfDownload(item)) return;

        // PRIVACY GATE — whitelist in capture-sources.js, per-source toggles in settings.
        if (!(await _isAcademicSource(item))) {
          console.log('[BG Downloads] non-academic PDF ignored:', (item.filename || item.url || '').split(/[\\/]/).pop());
          return;
        }
        const mode = await _downloadCaptureMode();
        // 'off' is the reader's global "do not touch my downloads" switch, and it
        // outranks an armed paper: consent given in the app cannot re-enable a
        // capture they have switched off here.
        if (mode === 'off') return;
        // Asked for by name in the app, minutes ago: import it without a second
        // consent step. This is the whole point of the attended-download flow —
        // the reader presses one button in the app and the paper appears.
        const armed = await _matchArmed(item);
        if (armed) {
          console.log('[BG Downloads] armed import (asked for in the app):', armed.ssrn_id || armed.doi);
          await _disarm(armed);
          await _ingestDownloadItem(item, armed);
          return;
        }
        if (mode === 'ask') {
          console.log('[BG Downloads] consent requested for:', (item.filename || item.url || '').split(/[\\/]/).pop());
          _offerImport(item);
          await _addPendingImport(item);
          return;
        }
        await _ingestDownloadItem(item);     // mode === 'auto'
      } catch (e) {
        console.warn('[BG Downloads] capture gate failed:', e && e.message);
        _ingestedDownloadIds.delete(delta.id);
      }
    })();
  });
  console.log('[BG] Download capture active — academic-source PDFs only; default mode asks before importing');
}