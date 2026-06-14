// Service worker configuration for Essence Scholar Extension
const CONFIG = {
  // Backend configuration with priority order
  BACKENDS: {
    // TEMPORARY: nightly is preferred while testing the new /ingest flow.
    NIGHTLY: {
      url: 'https://nightly-api.essencescholar.com',
      name: 'Nightly (testing)',
      priority: 1,
      enabled: true
    },
    LOCAL_DEV: {
      url: 'http://localhost:8080',
      name: 'Local Development',
      priority: 2,
      enabled: true
    },
    SELF_HOSTED: {
      url: 'https://scholar-api.essencescholar.com',
      name: 'Self-Hosted (always-on)',
      priority: 3,
      enabled: true
    },
    CLOUD_RUN: {
      url: 'https://ssrn-summarizer-backend-pisqy7uvxq-uc.a.run.app',
      name: 'Cloud Run',
      priority: 4,
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