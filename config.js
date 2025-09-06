// Configuration for Essence Scholar Extension
const CONFIG = {
  // Backend configuration with priority order
  BACKENDS: {
    LOCAL_DEV: {
      url: 'http://localhost:8080',
      name: 'Local Development',
      priority: 2,
      enabled: true
    },
    CLOUD_RUN: {
      url: 'https://ssrn-summarizer-backend-v1-7-0-pisqy7uvxq-uc.a.run.app',
      name: 'Cloud Run',
      priority: 1,
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
  
  // Timeouts
  REQUEST_TIMEOUT: 60000, // 60 seconds for local (increased from 10)
  CLOUD_REQUEST_TIMEOUT: 120000, // 120 seconds for cloud (increased from 30)
  RETRY_ATTEMPTS: 3,
  RETRY_DELAY: 1000, // 1 second
  HEALTH_CHECK_TIMEOUT: 1000, // 1 second for health checks (reduced for faster detection)
  
  // Analysis settings
  MAX_CONTENT_LENGTH: 50000, // characters
  ANALYSIS_CACHE_DURATION: 5 * 60 * 1000, // 5 minutes in milliseconds
  
  // Backend detection settings
  BACKEND_CACHE_DURATION: 5 * 60 * 1000, // Cache backend choice for 5 minutes (increased from 2)
  AUTO_DETECT_BACKENDS: false, // Disable automatic backend detection for efficiency
  PREFER_LOCAL: true, // Prefer local backends over cloud
  
  // Backend failure tracking
  MAX_CONSECUTIVE_FAILURES: 2, // Show update message after 2 consecutive failures
  FAILURE_RESET_DURATION: 10 * 60 * 1000, // Reset failure count after 10 minutes
};

// Optimized backend selection - simply use priority 1 backend
class BackendManager {
  // Track consecutive failures
  static _consecutiveFailures = 0;
  static _lastFailureTime = 0;
  static _updateMessageShown = false;

  // Get the priority 1 backend directly (no health checks)
  static getPriorityOneBackend() {
    const backends = Object.entries(CONFIG.BACKENDS)
      .filter(([key, backend]) => backend.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority);
    
    if (backends.length > 0) {
      const [key, backend] = backends[0];
      console.log(`🎯 Using priority 1 backend: ${backend.name} (${backend.url})`);
      return { key, ...backend };
    }
    
    console.log('❌ No enabled backends found');
    return null;
  }

  // Get current backend (simplified - just return priority 1)
  static async getCurrentBackend() {
    // Check if we have a cached backend choice
    if (window.currentBackend && window.backendCacheTime) {
      const now = Date.now();
      if (now - window.backendCacheTime < CONFIG.BACKEND_CACHE_DURATION) {
        console.log(`🔄 Using cached backend: ${window.currentBackend.name}`);
        return window.currentBackend;
      }
    }
    
    // Get priority 1 backend (no health checks)
    const backend = BackendManager.getPriorityOneBackend();
    if (backend) {
      window.currentBackend = backend;
      window.backendCacheTime = Date.now();
      console.log(`💾 Cached backend choice: ${backend.name}`);
    }
    return backend;
  }

  // Force refresh backend choice (simplified)
  static async refreshBackend() {
    window.currentBackend = null;
    window.backendCacheTime = null;
    console.log('🔄 Forced backend refresh');
    return await BackendManager.getCurrentBackend();
  }

  // Track backend failure and show update message if needed
  static trackBackendFailure(error = null) {
    const now = Date.now();
    
    // Reset failure count if enough time has passed
    if (now - BackendManager._lastFailureTime > CONFIG.FAILURE_RESET_DURATION) {
      BackendManager._consecutiveFailures = 0;
      BackendManager._updateMessageShown = false;
    }
    
    BackendManager._consecutiveFailures++;
    BackendManager._lastFailureTime = now;
    
    console.log(`❌ Backend failure #${BackendManager._consecutiveFailures} tracked`);
    
    // Show update message after 2 consecutive failures
    if (BackendManager._consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES && !BackendManager._updateMessageShown) {
      BackendManager._updateMessageShown = true;
      BackendManager.showUpdateMessage();
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
      
      // Method 2: Show alert if in fullpage context
      if (typeof window !== 'undefined' && window.location && window.location.href.includes('fullpage.html')) {
        alert('⚠️ Extension Update Required\n\nYour extension needs to be updated to work with the latest backend. Please update the extension from the Chrome Web Store.');
      }
      
      // Method 3: Store message for popup to read
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
    BackendManager._consecutiveFailures = 0;
    BackendManager._lastFailureTime = 0;
    BackendManager._updateMessageShown = false;
    console.log('✅ Backend failure tracking reset');
  }

  // Get current failure status
  static getFailureStatus() {
    return {
      consecutiveFailures: BackendManager._consecutiveFailures,
      lastFailureTime: BackendManager._lastFailureTime,
      updateMessageShown: BackendManager._updateMessageShown,
      shouldShowUpdate: BackendManager._consecutiveFailures >= CONFIG.MAX_CONSECUTIVE_FAILURES
    };
  }

  // Legacy method for compatibility (now just returns priority 1)
  static async detectBestBackend() {
    return BackendManager.getPriorityOneBackend();
  }

  // Legacy method for compatibility (now just returns priority 1)
  static async checkBackendHealth(backend) {
    // Skip health checks for efficiency
    console.log(`⏭️ Skipping health check for ${backend.name} (efficiency mode)`);
    return true;
  }

  // Legacy method for compatibility
  static getBackendsByPriority() {
    return Object.entries(CONFIG.BACKENDS)
      .filter(([key, backend]) => backend.enabled)
      .sort(([, a], [, b]) => a.priority - b.priority)
      .map(([key, backend]) => ({ key, ...backend }));
  }
}

// Helper function to get API URL with backend
function getApiUrlWithBackend(endpoint, backend) {
  return `${backend.url}${endpoint}`;
}

// Helper function to get API key from storage
async function getApiKey() {
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
  
  // 3. Try localStorage as fallback (from onboarding)
  if (!apiKey) {
    try {
      const localStorageKey = localStorage.getItem('essence_scholar_api_key');
      if (localStorageKey) {
        apiKey = localStorageKey;
      }
    } catch (error) {
      console.log('Error accessing localStorage:', error);
    }
  }
  
  return apiKey;
}

// Helper function to make API requests with explicit backend
async function makeApiRequestWithBackend(endpoint, options = {}, backend) {
  if (!backend) {
    throw new Error('No backend provided');
  }
  const url = `${backend.url}${endpoint}`;
  const timeout = backend.url.includes('localhost') 
    ? CONFIG.REQUEST_TIMEOUT 
    : CONFIG.CLOUD_REQUEST_TIMEOUT;
  
  // Get extension version for the request
  const manifest = chrome?.runtime?.getManifest?.();
  const extensionVersion = manifest ? `v${manifest.version}` : 'unknown';
  
  // Get API key for authentication
  const apiKey = await getApiKey();
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'X-Extension-Version': extensionVersion,
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
    
    // Check for version warnings in successful responses
    if (response.ok && window.checkResponseForVersionWarning) {
      response.clone().json().then(data => {
        if (data.version_warning) {
          window.checkResponseForVersionWarning(data.version_warning);
        }
      }).catch(() => {}); // Ignore errors for this check
    }
    
    // Reset failure tracking on successful response
    if (response.ok) {
      BackendManager.resetFailureTracking();
    } else {
      // Track failure for non-OK responses
      BackendManager.trackBackendFailure(new Error(`HTTP ${response.status}: ${response.statusText}`));
    }
    
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    
    // Track failure for network errors
    BackendManager.trackBackendFailure(error);
    
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

// Helper: auto-detect backend and make a non-stream request
async function makeApiRequest(endpoint, options = {}) {
  const backend = await BackendManager.getCurrentBackend();
  if (!backend) {
    throw new Error('No backend available');
  }
  return makeApiRequestWithBackend(endpoint, options, backend);
}

// Helper: perform SSE streaming request
function makeStreamRequest(endpoint, bodyObj = {}, onEvent = () => {}) {
  return new Promise(async (resolve, reject) => {
    try {
      const backend = await BackendManager.getCurrentBackend();
      if (!backend) {
        throw new Error('No backend available');
      }
      const url = `${backend.url}${endpoint}`;
      
      // Get extension version for the request
      const manifest = chrome?.runtime?.getManifest?.();
      const extensionVersion = manifest ? `v${manifest.version}` : 'unknown';
      
      // Get API key for authentication
      const apiKey = await getApiKey();
      
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'text/event-stream',
        'X-Extension-Version': extensionVersion
      };
      
      // Add Authorization header if API key is available
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(bodyObj)
      });
      
      // Track success/failure
      if (response.ok) {
        BackendManager.resetFailureTracking();
      } else {
        BackendManager.trackBackendFailure(new Error(`HTTP ${response.status}: ${response.statusText}`));
        reject(new Error(`Backend error: ${response.status}`));
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop();
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith('data:')) continue;
          const jsonStr = line.replace(/^data:\s*/, '');
          if (!jsonStr) continue;
          let evt;
          try {
            evt = JSON.parse(jsonStr);
          } catch (e) {
            console.warn('Failed to parse SSE event:', jsonStr);
            continue;
          }
          onEvent(evt);
        }
      }
      resolve();
    } catch (error) {
      reject(error);
    }
  });
}

// Make functions available globally
if (typeof window !== 'undefined') {
  window.makeApiRequestWithBackend = makeApiRequestWithBackend;
  window.makeApiRequest = makeApiRequest;
  window.makeStreamRequest = makeStreamRequest;

  window.BackendManager = BackendManager;
}
