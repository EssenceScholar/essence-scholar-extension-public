// Configuration for Essence Scholar Extension
const CONFIG = {
  // Backend configuration with priority order
  BACKENDS: {
    LOCAL_DEV: {
      url: 'http://localhost:8080',
      name: 'Local Development',
      priority: 1,
      enabled: true
    },
    CLOUD_RUN: {
      url: 'https://ssrn-summarizer-backend-v1-8-0-pisqy7uvxq-uc.a.run.app',
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
  AUTO_DETECT_BACKENDS: true, // Re-enabled automatic backend detection
  PREFER_LOCAL: true, // Prefer local backends over cloud
  
  // Backend failure tracking
  MAX_CONSECUTIVE_FAILURES: 2, // Show update message after 2 consecutive failures
  FAILURE_RESET_DURATION: 10 * 60 * 1000, // Reset failure count after 10 minutes
};

// Optimized backend selection with health checks
class BackendManager {
  // Track consecutive failures
  static _consecutiveFailures = 0;
  static _lastFailureTime = 0;
  static _updateMessageShown = false;

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
    // Check if we have a cached backend choice
    if (window.currentBackend && window.backendCacheTime) {
      const now = Date.now();
      if (now - window.backendCacheTime < CONFIG.BACKEND_CACHE_DURATION) {
        return window.currentBackend;
      }
    }
    
    let backend = null;
    if (CONFIG.AUTO_DETECT_BACKENDS) {
      backend = await BackendManager.detectBestBackend();
    } else {
      backend = BackendManager.getPriorityOneBackend();
    }

    if (backend) {
      window.currentBackend = backend;
      window.backendCacheTime = Date.now();
      console.log(`🎯 Using backend: ${backend.name} (${backend.url})`);
    }
    return backend;
  }

  // Detect the best available backend by checking health
  static async detectBestBackend() {
    const backends = BackendManager.getBackendsByPriority();
    
    for (const backend of backends) {
      const isHealthy = await BackendManager.checkBackendHealth(backend);
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
      console.log(`⚠️ Health check failed for ${backend.name}: ${error.message}`);
      return false;
    }
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
