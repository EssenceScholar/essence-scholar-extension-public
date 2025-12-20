document.addEventListener('DOMContentLoaded', function() {
  // Persistent analysis status utility functions
  const STATUS_KEY = 'analysisStatus';
  
  // Helper function to build fullpage URL with analysisID (new approach)
  function buildAnalysisUrl(analysisId, additionalParams = {}) {
    const baseUrl = chrome.runtime.getURL('fullpage.html');
    const params = new URLSearchParams();
    
    if (analysisId) {
      params.set('analysisID', analysisId);
    }
    
    // Add any additional parameters
    Object.entries(additionalParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.set(key, value);
      }
    });
    
    return `${baseUrl}?${params.toString()}`;
  }

  // Legacy function - kept for backward compatibility
  async function buildFullpageUrl(paperId, additionalParams = {}) {
    const baseUrl = chrome.runtime.getURL('fullpage.html');
    const params = new URLSearchParams();
    
    if (paperId) {
      params.set('paperID', paperId);
    }
    
    // Get current scholar URL from settings
    const settings = await chrome.storage.local.get(['userSettings']);
    const currentScholarUrl = settings.userSettings?.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en';
    
    // Add scholar parameter
    params.set('scholar', currentScholarUrl);
    
    // Add any additional parameters
    Object.entries(additionalParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.set(key, value);
      }
    });
    
    return `${baseUrl}?${params.toString()}`;
  }

  // Helper function to build fullpage URL using analysisID (preferred method)
  async function buildFullpageUrlWithAnalysisId(paperId, additionalParams = {}) {
    try {
      // Get current scholar URL from settings
      const settings = await chrome.storage.local.get(['userSettings']);
      const currentScholarUrl = settings.userSettings?.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en';
      
      // Generate analysisId
      const analysisId = await generateAnalysisId(paperId, currentScholarUrl);
      
      // Use the new analysisID approach
      return buildAnalysisUrl(analysisId, additionalParams);
    } catch (error) {
      console.error('Error building analysisID URL, falling back to legacy:', error);
      // Fallback to legacy method
      return await buildFullpageUrl(paperId, additionalParams);
    }
  }
  
  // Build paperID-based URLs (simpler approach without analysisID)
  function buildPaperIdUrl(paperId, additionalParams = {}) {
    const baseUrl = chrome.runtime.getURL('fullpage.html');
    const params = new URLSearchParams();
    
    if (paperId) {
      params.set('paperID', paperId);
    }
    
    // Add any additional parameters
    Object.entries(additionalParams).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        params.set(key, value);
      }
    });
    
    return `${baseUrl}?${params.toString()}`;
  }
  
  async function setAnalysisStatus(paperId, status, errorMessage = null) {
    console.log('Setting analysis status:', { paperId, status, errorMessage });
    const now = new Date().toISOString();
    const update = {
      status,
      updatedAt: now,
      paperId: paperId
    };
    if (status === 'in_progress') {
      update.startedAt = now;
    } else if (status === 'complete' || status === 'error') {
      update.finishedAt = now;
    }
    if (errorMessage) {
      update.errorMessage = errorMessage;
    }
    const storage = await chrome.storage.local.get([STATUS_KEY]);
    const allStatus = storage[STATUS_KEY] || {};
    allStatus[paperId] = update;
    await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
    console.log('Analysis status set successfully:', update);
  }
  
  async function getAnalysisStatus(paperId) {
    const storage = await chrome.storage.local.get([STATUS_KEY]);
    const allStatus = storage[STATUS_KEY] || {};
    return allStatus[paperId] || null;
  }
  
  // Function to check and monitor analysis status using local storage
  async function checkAndMonitorAnalysisStatus() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        console.log('No tab or URL found for status monitoring');
        return;
      }
      
      const paperId = await extractSsrnIdOrUrl(tab.url);
      if (!paperId) {
        console.log('No paper ID found for status monitoring');
        return;
      }
      
      console.log('Checking analysis status for paper ID:', paperId);
      const status = await getAnalysisStatus(paperId);
      console.log('Current analysis status:', status);
      
      // Always hide/disable View Analysis button unless status is complete
      setButtonState('Deep Read!', false, false);
      analyzeBtn.style.backgroundColor = '#2196F3';
      analyzeBtn.onclick = analyzePaper;

      if (!status) {
        // No local status, check backend
        const backendHasAnalysis = await hasAnalysisOnBackend(paperId);
        if (backendHasAnalysis) {
          showStatus('Analysis exists for this paper! Click "View Paper Page" to see results.', 'success');
          setButtonState('View Paper Page', false, false);
          analyzeBtn.style.backgroundColor = '#4CAF50';
          analyzeBtn.onclick = async () => {
            const fullpageUrl = buildPaperIdUrl(paperId);
            chrome.tabs.create({ url: fullpageUrl });
          };
          return;
        } else {
          showStatus('Analysis has not been done for this paper.', 'info');
          setButtonState('Deep Read!', false, false);
          analyzeBtn.style.backgroundColor = '#2196F3';
          analyzeBtn.onclick = analyzePaper;
          return;
        }
      }
      
      // Check if the status is stale (older than 5 minutes)
      const now = new Date().getTime();
      const startedAt = new Date(status.startedAt).getTime();
      const fiveMinutes = 5 * 60 * 1000;
      
      if (status.status === 'in_progress' && now - startedAt > fiveMinutes) {
        console.log('Found stale in_progress status, clearing...');
        await clearStaleAnalysisStatus();
        // Check backend before showing timeout error
        const backendHasAnalysis = await hasAnalysisOnBackend(paperId);
        if (backendHasAnalysis) {
          showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
          setButtonState('View Paper Page', false, false);
          analyzeBtn.style.backgroundColor = '#4CAF50';
          analyzeBtn.onclick = async () => {
            const fullpageUrl = buildPaperIdUrl(paperId);
            chrome.tabs.create({ url: fullpageUrl });
          };
          return;
        }
        // If backend does not have analysis, show not done message
        showStatus('Analysis has not been done for this paper.', 'info');
        setButtonState('Deep Read!', false, false);
        analyzeBtn.style.backgroundColor = '#2196F3';
        analyzeBtn.onclick = analyzePaper;
        return;
      }
      
      if (status.status === 'complete') {
        console.log('Analysis is complete, checking for results...');
        const hasResult = await checkForExistingAnalysis();
        if (hasResult) {
          showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
          setButtonState('View Paper Page', false, false);
          analyzeBtn.style.backgroundColor = '#4CAF50';
          analyzeBtn.onclick = async () => {
            const fullpageUrl = buildPaperIdUrl(paperId);
            chrome.tabs.create({ url: fullpageUrl });
          };
        } else {
          setButtonState('Deep Read!', false, false);
          analyzeBtn.style.backgroundColor = '#2196F3';
          analyzeBtn.onclick = analyzePaper;
          showStatus('Analysis complete, but no results found. Please try again.', 'error');
        }
        return;
      }
      
      if (status.status === 'in_progress') {
        console.log('Analysis in progress, starting monitoring...');
        if (status && status.status === 'in_progress') {
          // Only show in progress if there is a previous status or backend analysis
          const backendHasAnalysis = await hasAnalysisOnBackend(paperId);
          if (backendHasAnalysis) {
            showStatus('Analysis exists for this paper! Click "View Paper Page" to see results.', 'success');
            setButtonState('View Paper Page', false, false);
            analyzeBtn.style.backgroundColor = '#4CAF50';
            analyzeBtn.onclick = async () => {
              const fullpageUrl = buildPaperIdUrl(paperId);
              chrome.tabs.create({ url: fullpageUrl });
            };
            return;
          }
          // Only show in progress if there is a previous status (i.e., not a new paper)
          if (!status.startedAt) {
            // No previous analysis, do not show in progress
            setButtonState('Deep Read!', true, false);
            analyzeBtn.style.backgroundColor = '#ccc';
            analyzeBtn.onclick = null;
            return;
          }
          showStatus('Analysis in progress for this paper. Monitoring for completion... Please do not close this popup.', 'progress');
          setButtonState('Analyzing... Do Not Close Extension Popup', true, true);
          analyzeBtn.style.backgroundColor = '#FF9800';
        }
        
        let monitorStartTime = Date.now();
        const monitorTimeout = 5 * 60 * 1000; // 5 minutes timeout
        
        // Start monitoring for status changes
        const monitorInterval = setInterval(async () => {
          try {
            // Check if we've exceeded the timeout
            if (Date.now() - monitorStartTime > monitorTimeout) {
              console.log('Analysis monitoring timed out');
              clearInterval(monitorInterval);
              await clearStaleAnalysisStatus();
              showStatus('Analysis timed out. Please try again.', 'error');
              setButtonState('Deep Read!', false, false);
              analyzeBtn.style.backgroundColor = '#2196F3';
              analyzeBtn.onclick = analyzePaper;
              return;
            }
            
            const currentStatus = await getAnalysisStatus(paperId);
            console.log('Current status check result:', currentStatus);
            
            // First check if analysis is available on backend
            const backendHasAnalysis = await hasAnalysisOnBackend(paperId);
            if (backendHasAnalysis) {
              clearInterval(monitorInterval);
              showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
              setButtonState('View Paper Page', false, false);
              analyzeBtn.style.backgroundColor = '#4CAF50';
              analyzeBtn.onclick = async () => {
                const fullpageUrl = buildPaperIdUrl(paperId);
                chrome.tabs.create({ url: fullpageUrl });
              };
              return;
            }
            
            if (!currentStatus || currentStatus.status === 'error') {
              clearInterval(monitorInterval);
              showStatus('Analysis failed: ' + (currentStatus?.errorMessage || 'Unknown error'), 'error');
              setButtonState('Deep Read!', false, false);
              analyzeBtn.style.backgroundColor = '#2196F3';
              analyzeBtn.onclick = analyzePaper;
              return;
            }
            
            if (currentStatus.status === 'complete') {
              clearInterval(monitorInterval);
              const hasResult = await checkForExistingAnalysis();
              if (hasResult) {
                showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
                setButtonState('View Paper Page', false, false);
                analyzeBtn.style.backgroundColor = '#4CAF50';
                analyzeBtn.onclick = async () => {
                  const fullpageUrl = buildPaperIdUrl(paperId);
                  chrome.tabs.create({ url: fullpageUrl });
                };
              } else {
                // If local storage says complete but no results, check backend one more time
                const backendRecheck = await hasAnalysisOnBackend(paperId);
                if (backendRecheck) {
                  showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
                  setButtonState('View Paper Page', false, false);
                  analyzeBtn.style.backgroundColor = '#4CAF50';
                  analyzeBtn.onclick = async () => {
                    const fullpageUrl = buildPaperIdUrl(paperId);
                    chrome.tabs.create({ url: fullpageUrl });
                  };
                } else {
                  setButtonState('Deep Read!', false, false);
                  analyzeBtn.style.backgroundColor = '#2196F3';
                  analyzeBtn.onclick = analyzePaper;
                  showStatus('Analysis complete, but no results found. Please try again.', 'error');
                }
              }
            }
          } catch (error) {
            console.error('Error monitoring analysis status:', error);
            clearInterval(monitorInterval);
            showStatus('Error monitoring analysis status. Please try again.', 'error');
            setButtonState('Deep Read!', false, false);
            analyzeBtn.style.backgroundColor = '#2196F3';
            analyzeBtn.onclick = analyzePaper;
          }
        }, 2000);
      }
    } catch (error) {
      console.error('Error checking analysis status:', error);
      showStatus('Error checking analysis status. Please try again.', 'error');
      setButtonState('Deep Read!', false, false);
      analyzeBtn.style.backgroundColor = '#2196F3';
      analyzeBtn.onclick = analyzePaper;
    }
  }
  
  // Function to restore analysis state if in progress (reconnected to background script)
  async function restoreAnalysisState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      // First check local storage status
      const paperId = await extractSsrnIdOrUrl(tab.url);
      if (paperId) {
        const localStatus = await getAnalysisStatus(paperId);
        if (localStatus && localStatus.status === 'in_progress') {
          console.log('Local storage shows analysis in progress, starting monitoring...');
          // Start monitoring for completion
          checkAndMonitorAnalysisStatus();
          return;
        }
      }

      // If no local status, check background script status
      const status = await checkAnalysisStatus(tab.id);
      
      if (status.inProgress || status.analysisInProgress) {
        console.log('Background script shows analysis in progress, setting local status...');
        
        // Set local status to in progress and start monitoring
        if (tab.url) {
          const paperId = await extractSsrnIdOrUrl(tab.url);
          if (paperId) {
            await setAnalysisStatus(paperId, 'in_progress');
            checkAndMonitorAnalysisStatus();
          }
        }
      } else if (status.hasAnalysis) {
        // Background script indicates analysis exists for this tab
        console.log('Background script indicates analysis exists for this tab');
        
        // Check for recent completed analysis in storage
        const hasExistingAnalysis = await checkForExistingAnalysis();
        if (hasExistingAnalysis) {
          console.log('Analysis results found in storage, UI should be updated by checkForExistingAnalysis');
        } else {
          // If storage doesn't have it, still show the View Paper Page button
          setButtonState('View Paper Page', false, false);
          analyzeBtn.style.backgroundColor = '#4CAF50';
          analyzeBtn.onclick = async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url) return;
            const paperId = await extractSsrnIdOrUrl(tab.url);
            const fullpageUrl = buildPaperIdUrl(paperId);
            chrome.tabs.create({ url: fullpageUrl });
          };
          showStatus('Analysis complete for this paper! Click "View Paper Page" to see results.', 'success');
        }
      }
    } catch (error) {
      console.error('Error restoring analysis state:', error);
    }
  }
  // Get DOM elements using new IDs
  const analyzeBtn = document.getElementById('analyze-btn');
  const homeBtn = document.getElementById('home-btn');
  const settingsBtn = document.getElementById('settings-btn');
  const analyzeAuthorsBtn = document.getElementById('analyze-authors-btn');
  const statusContainer = document.getElementById('status-container');

  // Function to show progress (simplified for new design)
  function showProgress(step, message) {
    showStatus(message, 'progress');
    
    // Show progress container
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
      progressContainer.style.display = 'block';
      
      // Update progress bar
      const progressFill = progressContainer.querySelector('.progress-fill');
      const progressSteps = progressContainer.querySelectorAll('.progress-steps .step');
      
      if (progressFill) {
        const progressPercent = (step / 3) * 100;
        progressFill.style.width = `${progressPercent}%`;
      }
      
      // Update step indicators
      progressSteps.forEach((stepElement, index) => {
        stepElement.classList.remove('active', 'completed');
        if (index < step - 1) {
          stepElement.classList.add('completed');
        } else if (index === step - 1) {
          stepElement.classList.add('active');
        }
      });
    }
  }

  // Function to hide progress (simplified for new design)
  function hideProgress() {
    clearStatus();
    
    // Hide progress container
    const progressContainer = document.getElementById('progress-container');
    if (progressContainer) {
      progressContainer.style.display = 'none';
    }
  }

  // Function to set button state
  function setButtonState(text, disabled = false, showIcon = false) {
    if (analyzeBtn) {
      const textElement = analyzeBtn.querySelector('.button-text');
      const iconElement = analyzeBtn.querySelector('.button-icon');
      
      if (textElement) textElement.textContent = text;
      analyzeBtn.disabled = disabled;
      if (iconElement) iconElement.style.display = showIcon ? 'inline' : 'none';
    }
  }

  // Function to set authors button state
  function setAuthorsButtonState(text, disabled = false, showIcon = false) {
    if (analyzeAuthorsBtn) {
      const textElement = analyzeAuthorsBtn.querySelector('.button-text');
      const iconElement = analyzeAuthorsBtn.querySelector('.button-icon');
      
      if (textElement) textElement.textContent = text;
      analyzeAuthorsBtn.disabled = disabled;
      if (iconElement) iconElement.style.display = showIcon ? 'inline' : 'none';
    }
  }

  // Function to show/hide authors button
  function showAuthorsButton(show = true) {
    if (analyzeAuthorsBtn) {
      analyzeAuthorsBtn.style.display = show ? 'block' : 'none';
    }
  }



  // Function to show status messages
  function showStatus(message, type = 'info') {
    if (!statusContainer) {
      console.error('Status container not found, disabling analyze button');
      const analyzeBtn = document.getElementById('analyze-btn');
      if (analyzeBtn) {
        setButtonState('Deep Read!', true, false);
        analyzeBtn.style.backgroundColor = '#ccc';
      }
      return;
    }

    // Clear any existing error display
    const errorContainer = document.getElementById('error-container');
    if (!errorContainer) {
      // Fallback to simple status display if error container is not available
      statusContainer.innerHTML = `
        <div class="status-message ${type}">
          ${message}
        </div>
      `;
      // If it's an error, also disable the analyze button
      if (type === 'error') {
        const analyzeBtn = document.getElementById('analyze-btn');
        if (analyzeBtn) {
          setButtonState('Deep Read!', true, false);
          analyzeBtn.style.backgroundColor = '#ccc';
        }
      }
      return;
    }

    errorContainer.style.display = 'none';

    // For error messages, use the new error container
    if (type === 'error') {
      try {
        const errorTitle = errorContainer.querySelector('.error-title');
        const errorMessage = errorContainer.querySelector('.error-message');
        const errorAction = errorContainer.querySelector('.error-action');

        if (!errorTitle || !errorMessage || !errorAction) {
          throw new Error('Error container elements not found');
        }

        // Parse the error message
        let title = 'Error';
        let detail = message;
        let action = '';

      if (message.includes('Cannot proceed with analysis:')) {
        title = 'Cannot Analyze PDF';
        detail = message.replace('Cannot proceed with analysis:', '').trim();
      } else if (message.includes('Cannot access PDF URL:')) {
        title = 'Cannot Access PDF';
        detail = 'The PDF file is not accessible.';
        action = 'Please ensure you are logged in and have proper permissions.';
      } else if (message.includes('404')) {
        title = 'PDF Not Found';
        detail = 'The PDF file could not be found at the specified URL.';
        action = 'Please check if the URL is correct and accessible.';
      } else if (message.includes('403')) {
        title = 'Access Denied';
        detail = 'Access to this PDF is restricted.';
        action = 'Please log in to the website or ensure you have proper permissions.';
      } else if (message.includes('login page') || message.includes('authentication')) {
        title = 'Authentication Required';
        detail = 'This appears to be a secure PDF requiring login.';
        action = 'Please log in to the website first, then try again.';
      }

        errorTitle.textContent = title;
        errorMessage.textContent = detail;
        errorAction.textContent = action;
        errorContainer.style.display = 'flex';
        
        // Hide the regular status message
        statusContainer.innerHTML = '';
        
        // Always disable the analyze button for errors
        const analyzeBtn = document.getElementById('analyze-btn');
        if (analyzeBtn) {
          setButtonState('Deep Read!', true, false);
          analyzeBtn.style.backgroundColor = '#ccc';
        }
      } catch (error) {
        // Fallback to simple error display if error container is broken
        console.error('Error displaying detailed error:', error);
        statusContainer.innerHTML = `
          <div class="status-message error">
            ${message}
          </div>
        `;
        // Still disable the analyze button
        const analyzeBtn = document.getElementById('analyze-btn');
        if (analyzeBtn) {
          setButtonState('Deep Read!', true, false);
          analyzeBtn.style.backgroundColor = '#ccc';
        }
      }
    } else {
      // For non-error messages, use the regular status display
      statusContainer.innerHTML = `
        <div class="status-message ${type}">
          ${message}
        </div>
      `;
    }
  }

  // Function to clear status messages
  function clearStatus() {
    if (statusContainer) {
      statusContainer.innerHTML = '';
    }
  }

  // Function to inject content script if needed (legacy - now uses enhanced version)
  async function ensureContentScript(tabId) {
    // Use the enhanced version from PDFHandler
    if (window.PDFHandler && window.PDFHandler.ensureContentScriptWithRetry) {
      return await window.PDFHandler.ensureContentScriptWithRetry(tabId);
    }
    
    // Fallback to original implementation
    try {
      // First check if content script is already injected
      try {
        await chrome.tabs.sendMessage(tabId, { action: 'ping' });
        console.log('Content script already injected, skipping injection');
        return true;
      } catch (error) {
        // Content script not injected, proceed with injection
        console.log('Content script not found, injecting...');
      }
      
      // Check URL accessibility before injection
      const tab = await chrome.tabs.get(tabId);
      if (window.PDFHandler && window.PDFHandler.isUrlAccessibleForContentScript && 
          !window.PDFHandler.isUrlAccessibleForContentScript(tab.url)) {
        throw new Error(`Cannot inject content script into ${tab.url.split('://')[0]}:// URL`);
      }
      
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      console.log('Content script injected successfully');
      
      // Wait a moment for the script to initialize
      await new Promise(resolve => setTimeout(resolve, 100));
      return true;
    } catch (error) {
      console.error('Content script injection failed:', error);
      throw new Error(`Failed to inject content script: ${error.message}`);
    }
  }

  // Function to check for existing analysis (only called when user explicitly requests analysis)
  async function checkForExistingAnalysis() {
    try {
      // Get the current active tab to check for tab-specific analysis
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        console.log('No active tab found for analysis check');
        return false;
      }

      // Check for tab-specific analysis results
      const result = await chrome.storage.local.get(['analysisResults']);
      const allResults = result.analysisResults || {};
      
      // Look for analysis results for this specific tab URL
      const tabAnalysis = allResults[tab.url];
      if (tabAnalysis) {
        console.log('Found existing analysis for this tab:', tabAnalysis);
        
        // Check if this analysis is recent (within last 5 minutes)
        const analysisTime = new Date(tabAnalysis.timestamp);
        const now = new Date();
        const timeDiff = now - analysisTime;
        const isRecent = timeDiff < 5 * 60 * 1000; // 5 minutes
        
        if (isRecent) {
          // Show that analysis exists and offer to view it
          setButtonState('View Paper Page', false, false);
          analyzeBtn.style.backgroundColor = '#4CAF50';
          analyzeBtn.onclick = async () => {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (!tab || !tab.url) return;
            const paperId = await extractSsrnIdOrUrl(tab.url);
            const fullpageUrl = buildPaperIdUrl(paperId);
            chrome.tabs.create({ url: fullpageUrl });
          };
          
          showStatus('DONE: Analysis already exists for this paper! Click "View Paper Page" to see results.', 'success');
          return true; // Indicate that analysis exists
        } else {
          console.log('Analysis exists but is too old, removing from storage');
          // Remove old analysis from storage
          delete allResults[tab.url];
          await chrome.storage.local.set({ analysisResults: allResults });
        }
      }
      
      // Also check legacy global lastAnalysis for backward compatibility
      const legacyResult = await chrome.storage.local.get(['lastAnalysis']);
      if (legacyResult.lastAnalysis) {
        const analysis = legacyResult.lastAnalysis;
        console.log('Found legacy analysis:', analysis);
        
        // Check if this analysis is for the current tab
        if (analysis.url === tab.url) {
          const analysisTime = new Date(analysis.timestamp);
          const now = new Date();
          const timeDiff = now - analysisTime;
          const isRecent = timeDiff < 5 * 60 * 1000; // 5 minutes
          
          if (isRecent) {
            // Migrate to new storage format
            const newResults = allResults || {};
            newResults[tab.url] = analysis;
            await chrome.storage.local.set({ analysisResults: newResults });
            
            // Show that analysis exists and offer to view it
            setButtonState('View Paper Page', false, false);
            analyzeBtn.style.backgroundColor = '#4CAF50';
            analyzeBtn.onclick = async () => {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              if (!tab || !tab.url) return;
              const paperId = await extractSsrnIdOrUrl(tab.url);
              const fullpageUrl = buildPaperIdUrl(paperId);
              chrome.tabs.create({ url: fullpageUrl });
            };
            
            showStatus('DONE: Analysis already exists for this paper! Click "View Paper Page" to see results.', 'success');
            return true;
          }
        }
      }
      
      return false; // No recent analysis found for this tab
    } catch (error) {
      console.error('Error checking for existing analysis:', error);
      return false;
    }
  }

  // Function to check analysis status from background script (legacy - not used for status monitoring)
  async function checkAnalysisStatus(tabId) {
    try {
      const response = await chrome.runtime.sendMessage({ 
        action: 'checkAnalysisStatus',
        tabId: tabId 
      });
      return response || { inProgress: false, hasAnalysis: false, analysisInProgress: false };
    } catch (error) {
      console.error('Error checking analysis status:', error);
      return { inProgress: false, hasAnalysis: false, analysisInProgress: false };
    }
  }

  // Function to restore analysis state if in progress
  async function restoreAnalysisState() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab) return;

      const status = await checkAnalysisStatus(tab.id);
      
      if (status.inProgress || status.analysisInProgress) {
        console.log('Analysis in progress detected, restoring UI state');
        
        // Show that analysis is in progress
        setButtonState('Analyzing... Do Not Close Extension Popup', true, true);
        showProgress(2, 'Analysis in progress. Please wait... Do not close this popup.');
        
        // Set up monitoring to check for completion
        monitorAnalysisProgress(tab.id).catch(error => {
          console.error('Error in analysis monitoring:', error);
        });
      } else if (status.queued) {
        console.log('Analysis queued detected, restoring UI state');
        
        // Show that analysis is queued
        setButtonState('Queued...', true, true);
        const queueMsg = status.queuePosition > 0 
          ? `Analysis queued. Position: ${status.queuePosition}. Please wait...`
          : 'Analysis queued. Please wait...';
        showProgress(1, queueMsg);
        
        // Set up monitoring to check for completion
        monitorAnalysisProgress(tab.id).catch(error => {
          console.error('Error in analysis monitoring:', error);
        });
      } else if (status.hasAnalysis) {
        // Check for recent completed analysis
        const hasExistingAnalysis = await checkForExistingAnalysis();
        if (!hasExistingAnalysis) {
          // No recent analysis in storage, but background script says we have one
          console.log('Background script indicates analysis exists, but not in storage');
        }
      }
    } catch (error) {
      console.error('Error restoring analysis state:', error);
    }
  }

  // Function to monitor analysis progress and update UI when complete
  async function monitorAnalysisProgress(tabId, paperId, isPdf = false) {
    console.log('[POPUP] Starting background monitoring for paper:', paperId, 'tab:', tabId);
    
    try {
      // Use global backend instead of tab-specific
      const backend = await BackendManager.getCurrentBackend();
      if (!backend) {
        console.error('[POPUP] No backend available for monitoring');
        return;
      }
      
      // Start monitoring in background script
      const response = await chrome.runtime.sendMessage({
        action: 'startMonitoring',
        paperId: paperId,
        tabId: tabId,
        backend: backend
      });
      
      if (response.success) {
        console.log('[POPUP] Background monitoring started successfully');
        showProgress(1, 'Analysis in progress. Monitoring in background... Do not close this popup.');
      } else {
        console.error('[POPUP] Failed to start background monitoring');
      }
      
    } catch (error) {
      console.error('[POPUP] Error starting background monitoring:', error);
    }
  }

  // Function to stop analysis monitoring
  async function stopAnalysisMonitoring(paperId) {
    try {
      await chrome.runtime.sendMessage({
        action: 'stopMonitoring',
        paperId: paperId
      });
      console.log('[POPUP] Background monitoring stopped for paper:', paperId);
    } catch (error) {
      console.error('[POPUP] Error stopping background monitoring:', error);
    }
  }

  // Function to check if monitoring is active
  async function getMonitoringStatus(paperId) {
    try {
      const response = await chrome.runtime.sendMessage({
        action: 'getMonitoringStatus',
        paperId: paperId
      });
      return response.status;
    } catch (error) {
      console.error('[POPUP] Error getting monitoring status:', error);
      return null;
    }
  }

  // Helper: perform SSE analysis with progress callback
  async function analyzeWithSmartBackendStream(payload, progressCallback = () => {}) {
    try {
      const finalData = await makeStreamRequest(CONFIG.ANALYZE_STREAM_ENDPOINT, payload, (eventData) => {
        if (!eventData) return;
        // Map backend events to checklist updates
        if (eventData.section) {
          if (eventData.status === 'junior_start') {
            updateTaskStatus(eventData.section, 'in_progress');
          } else if (eventData.status === 'junior_done' || eventData.status === 'authors_extracted') {
            updateTaskStatus(eventData.section, 'done');
          }
        } else if (eventData.status === 'extracting_pdf') {
          updateTaskStatus('PDF Extraction', 'in_progress');
        } else if (eventData.status === 'pdf_extracted') {
          updateTaskStatus('PDF Extraction', 'done');
        } else if (eventData.status === 'analyzing') {
          // high-level analyze step
          updateTaskStatus('Analysis', 'in_progress');
        } else if (eventData.status === 'done') {
          updateTaskStatus('Analysis', 'done');
        }

        // Forward message to generic progress handler
        if (eventData.message) progressCallback(eventData.message);
      });
      return finalData;
    } catch (error) {
      console.error('Popup: Streaming analysis failed:', error);
      throw error;
    }
  }

  // Function to analyze paper
  async function analyzePaper() {
    try {
      if (UnderAnalysis) {
        console.log('analyzePaper called while UnderAnalysis = 1; ignoring duplicate click');
        return;
      }
      
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) {
        showStatus('No active tab found', 'error');
        return;
      }

      const isPdf = tab.url.toLowerCase().endsWith('.pdf');
      
      // Skip this function for PDFs - they are handled directly in updatePopupUI
      if (isPdf) {
        console.log('analyzePaper: PDF detected, but PDF analysis is handled in updatePopupUI. Skipping.');
        return;
      }

      UnderAnalysis = 1;

      // Extract paper ID (fallback to filename for PDFs)
      const paperId = (await extractSsrnIdOrUrl(tab.url)) || tab.url.split('/').pop();
      
      // Update UI to show analysis is starting
      await setAnalysisStatus(paperId, 'in_progress');
      showStatus('Analysis in progress for this paper... Please do not close this popup.', 'progress');
      setButtonState('Analyzing... Do Not Close Extension Popup', true, true);
      analyzeBtn.style.backgroundColor = '#FF9800';

      // Use background script workflow for HTML SSRN pages
      await chrome.runtime.sendMessage({
        action: 'analysisStarted',
        tabId: tab.id,
        url: tab.url
      });
      // Start monitoring progress via storage
      checkAndMonitorAnalysisStatus();
    } catch (error) {
      console.error('Error in analyzePaper:', error);
      const errorMessage = error.message || 'Unknown error occurred';
      
      // Get the current tab URL for status cleanup
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab && tab.url) {
          const paperId = await extractSsrnIdOrUrl(tab.url);
          if (paperId) {
            // Set error status
            await setAnalysisStatus(paperId, 'error', errorMessage);
            
            // Clear the status
            const storage = await chrome.storage.local.get([STATUS_KEY]);
            const allStatus = storage[STATUS_KEY] || {};
            delete allStatus[paperId];
            await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
          }
        }
      } catch (e) {
        console.error('Error cleaning up analysis status:', e);
      }

      showStatus('Analysis failed: ' + errorMessage, 'error');
      setButtonState('Deep Read!', false, false);
      analyzeBtn.style.backgroundColor = '#2196F3';
      analyzeBtn.onclick = analyzePaper;
    }
  }

  // Display backend status
  function displayBackendStatus(message = '🔍 Checking Version...') {
    const statusDiv = document.getElementById('backend-status');
    if (statusDiv) {
      statusDiv.innerHTML = `<div class="info">${message}</div>`;
    }
  }

  // Update backend loading state
  function updateBackendLoadingState(isLoading = true, message = 'Connecting to backend...') {
    const backendLoading = document.getElementById('backend-loading');
    const loadingText = backendLoading?.querySelector('.loading-text');
    
    if (backendLoading) {
      backendLoading.style.display = isLoading ? 'block' : 'none';
    }
    
    if (loadingText) {
      loadingText.textContent = message;
    }
  }

  // Update configuration status display
  async function updateConfigurationStatus() {
    const configStatusDiv = document.getElementById('config-status');
    if (!configStatusDiv) return;
    
    try {
      const result = await chrome.storage.local.get(['llmSettings']);
      const settings = result.llmSettings || { model: 'gemini-3-flash-preview' };
      
      // No API key validation needed - backend handles all LLM API keys
      configStatusDiv.style.display = 'none';
      
      // Fetch and display user credits
      await fetchAndDisplayCredits();
    } catch (error) {
      console.error('Error checking configuration status:', error);
    }
  }

  // Update backend status display - REMOVED DUPLICATE (kept final version at end of file)

  // Function to check if current tab is a PDF and set up the UI accordingly
  async function checkPageType() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      
      // Check if it's a PDF page using multiple criteria
      const isPDF = await checkIfPDFPage(tab);
      
      // Check if it's an SSRN page
      const isSSRN = tab.url && tab.url.includes('ssrn.com');

      if (isPDF && isSSRN) {
        // PDF detected on SSRN page - show guidance to user
        const fileName = tab.url.split('/').pop() || 'PDF file';
        
        showStatus(`📄 Local PDF File Detected: ${fileName}`, 'info');
        
        // Disable the main analyze button for local files
        setButtonState('Deep Read!', true, false); // Disable main button
        analyzeBtn.style.backgroundColor = '#ccc'; // Gray out main button
        analyzeBtn.style.cursor = 'not-allowed'; // Show disabled cursor
        showAuthorsButton(false); // Hide authors button for local PDFs
        
      // } else if (!isPDF && isSSRN) {
      //   // SSRN page without PDF: disable main analyze button, enable authors button
      //   setButtonState('Deep Read!', true, false); // Disable main button
      //   analyzeBtn.style.backgroundColor = '#ccc';
      //   showAuthorsButton(true);
      //   showStatus('SSRN page detected. Click "Analyze Authors" to analyze author profiles.', 'info');
      //   return;
      }
      
      // if (tab.url && tab.url.includes('ssrn.com')) {
      //   // SSRN page detected - only show author analysis option
      //   showStatus('SSRN page detected. Click "Analyze Authors" to analyze author profiles.', 'info');
      //   setButtonState('Deep Read!', true, false); // Disable paper analysis button
      //   analyzeBtn.style.backgroundColor = '#ccc'; // Gray out the button
        
      //   // Show only authors button for SSRN pages
      //   showAuthorsButton(true);
      //   setAuthorsButtonState('Analyze Authors', false, false);
      //   analyzeAuthorsBtn.style.backgroundColor = '#9C27B0';
        
      // } else {
      //   // Not a supported page
      //   showStatus('Navigate to a PDF file', 'info');
      //   setButtonState('Deep Read!', true, false); // Disable button
      //   analyzeBtn.style.backgroundColor = '#ccc';
      //   showAuthorsButton(false); // Hide authors button for unsupported pages
      // }
    } catch (error) {
      console.error('Error checking page type:', error);
      showStatus('Error checking page status. Please try again.', 'error');
      showAuthorsButton(false);
    }
  }

  // Function to check if a tab contains a PDF and if it's accessible
  async function checkIfPDFPage(tab) {
    try {
      // Prefer enhanced detector if available
      if (window.PDFHandler && typeof window.PDFHandler.checkIfPDFPage === 'function') {
        try {
          const enhanced = await window.PDFHandler.checkIfPDFPage(tab);
          if (enhanced && typeof enhanced.isPDF !== 'undefined') {
            return enhanced;
          }
        } catch (e) {
          console.log('Enhanced PDF check failed, falling back to legacy:', e?.message || e);
        }
      }

      console.log('Popup: Checking PDF status and accessibility...');
      console.log('Popup: Tab details:', { url: tab.url, title: tab.title });
      
      // First, ensure content script is injected
      try {
        console.log('Popup: Ensuring content script is available...');
        await ensureContentScript(tab.id);
        
        // Wait for content script to be ready
        let retries = 0;
        const maxRetries = 8; // Increased retries for better reliability
        let contentScriptReady = false;
        
        while (retries < maxRetries && !contentScriptReady) {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
            contentScriptReady = true;
            console.log('Popup: Content script is ready for PDF check');
          } catch (error) {
            retries++;
            console.log(`Popup: Content script not ready yet, retry ${retries}/${maxRetries}`);
            // Progressive backoff - longer waits for later retries
            const waitTime = retries <= 3 ? 100 : 200;
            await new Promise(resolve => setTimeout(resolve, waitTime));
          }
        }
        
        if (contentScriptReady) {
          // Try enhanced accessibility check
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'checkPDFAccessibility' });
            
            if (response && response.isPDF !== undefined) {
              console.log('Popup: Enhanced PDF check result:', { isPDF: response.isPDF, accessible: response.accessible });
              return {
                isPDF: response.isPDF,
                accessible: response.accessible
              };
            }
          } catch (e) {
            console.log('Popup: Enhanced check failed, trying basic check');
          }
          
          // Check if PDF collector has already detected PDF for this tab
          if (window.currentPdfInfo) {
            console.log('Popup: Using PDF collector info:', window.currentPdfInfo);
            return {
              isPDF: true,
              accessible: !window.currentPdfInfo.fallback
            };
          }
          
          // Try basic PDF status check (fallback to legacy content script if available)
          try {
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'checkPDFStatus' });
            if (response && response.isPDF !== undefined) {
              console.log('Popup: Basic PDF check result:', { isPDF: response.isPDF, canAccess: response.canAccess });
              return {
                isPDF: response.isPDF,
                accessible: response.canAccess !== false
              };
            }
          } catch (e) {
            console.log('Popup: Basic PDF check also failed');
          }
        }
      } catch (e) {
        console.log('Popup: Content script injection/communication failed:', e);
        
        // If content script fails but we have strong PDF indicators, proceed with fallback
        const url = tab.url.toLowerCase();
        const title = (tab.title || '').toLowerCase();
        const isFileProtocol = tab.url.startsWith('file:///');
        
        // Check for strong PDF indicators that suggest it should be accessible
        const hasStrongPdfIndicators = (
          url.includes('.pdf') ||
          isFileProtocol ||
          title.includes('pdf viewer') ||
          title.includes('pdf.js') ||
          title.includes('.pdf')
        );
        
        if (hasStrongPdfIndicators) {
          console.log('Popup: Strong PDF indicators detected despite content script failure, treating as accessible');
          return {
            isPDF: true,
            accessible: true // Assume accessible for strong indicators
          };
        }
      }

      // URL-based fallback with better accessibility logic
      const url = tab.url.toLowerCase();
      const isFileProtocol = tab.url.startsWith('file:///');
      const isHttpsProtocol = tab.url.startsWith('https://');
      const isHttpProtocol = tab.url.startsWith('http://');
      
      const hasObviousPdfUrl = url.includes('.pdf') && (
        url.includes('pdf.') ||
        url.includes('/pdf/') ||
        isFileProtocol ||
        url.endsWith('.pdf')
      );
      
      if (hasObviousPdfUrl) {
        console.log('Popup: PDF detected via URL pattern');
        // File protocol PDFs are usually accessible, web PDFs need verification
        const accessible = isFileProtocol || (isHttpsProtocol || isHttpProtocol);
        return {
          isPDF: true,
          accessible: accessible
        };
      }
      
      // Title-based detection - be more specific
      const title = tab.title || '';
      const lowerTitle = title.toLowerCase();
      
      // Look for more specific PDF indicators in title
      const hasPdfExtension = lowerTitle.includes('.pdf');
      const hasPdfViewer = lowerTitle.includes('pdf viewer') || lowerTitle.includes('pdf.js');
      const isGoogleDriveViewer = url.includes('drive.google.com') && lowerTitle.includes('pdf');
      const isBrowserPdfViewer = lowerTitle.includes('pdf') && (url.startsWith('file:///') || url.startsWith('chrome-extension://') || url.startsWith('moz-extension://'));
      
      if (hasPdfExtension || hasPdfViewer || isGoogleDriveViewer || isBrowserPdfViewer) {
        console.log('Popup: PDF detected via title/context', { 
          hasPdfExtension, 
          hasPdfViewer, 
          isGoogleDriveViewer, 
          isBrowserPdfViewer,
          url: url.substring(0, 50) + '...',
          title: title.substring(0, 50) + '...'
        });
        
        // Determine accessibility based on context
        let accessible = false;
        if (isFileProtocol) {
          accessible = true; // Local files are accessible
        } else if (hasPdfViewer || isBrowserPdfViewer) {
          accessible = true; // Browser PDF viewers are accessible
        } else if (isGoogleDriveViewer) {
          accessible = true; // Google Drive PDFs are usually accessible
        } else if (hasPdfExtension && (isHttpsProtocol || isHttpProtocol)) {
          accessible = true; // Web PDFs with .pdf extension are usually accessible
        }
        
        console.log('Popup: PDF accessibility determined:', accessible);
        return {
          isPDF: true,
          accessible: accessible
        };
      }
      
      console.log('Popup: No PDF detected');
      return { isPDF: false, accessible: false };
      
    } catch (error) {
      console.error('Popup: Error checking PDF:', error);
      return { isPDF: false, accessible: false };
    }
  }

  // Use shared ID generator for consistent paper ID generation
  async function extractSsrnIdOrUrl(url) {
    if (!url) return null;
    
    // Use the shared ID generator which matches backend logic
    try {
      const paperId = await SharedIdGenerator.generateIdFromUrl(url);
      return paperId;
    } catch (error) {
      console.error('Error generating paper ID:', error);
      // Fallback to simple SSRN ID extraction
      const match = url.match(/[?&]abstract(?:_?id)?=(\d+)/i);
      const fallbackId = match ? match[1] : url;
      return fallbackId;
    }
  }

  // Event listeners - removed permanent analyzePaper listener since we set onclick dynamically in updatePopupUI
  
  if (analyzeAuthorsBtn) {
    analyzeAuthorsBtn.addEventListener('click', analyzeAuthors);
  }
  

  
  if (homeBtn) {
    homeBtn.addEventListener('click', function() {
      chrome.tabs.create({
        url: chrome.runtime.getURL('fullpage.html')
      });
    });
  }

  // Onboarding button
  const onboardingBtn = document.getElementById('onboarding-btn');
  if (onboardingBtn) {
    onboardingBtn.addEventListener('click', function() {
      chrome.tabs.create({
        url: chrome.runtime.getURL('onboarding.html')
      });
    });
  }


  // Settings modal logic
  const settingsModal = document.getElementById('settings-modal');
  const modelSelect = document.getElementById('model-select');
  const settingsSaveBtn = document.getElementById('settings-save-btn');
  const settingsCancelBtn = document.getElementById('settings-cancel-btn');

  // Open settings modal
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      // Load settings from storage
      chrome.storage.local.get(['llmSettings'], (result) => {
        const settings = result.llmSettings || { model: 'gemini-3-flash-preview' };
        
        console.log('🔍 Popup: Loading LLM settings from storage:', {
          model: settings.model
        });
        
        modelSelect.value = settings.model || 'gemini-3-flash-preview';
        settingsModal.style.display = 'flex';
      });
    });
  }

  // Close modal on cancel
  if (settingsCancelBtn) {
    settingsCancelBtn.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
  }

  // Model selection change handler - no API key sections to show/hide

  // Save settings
  if (settingsSaveBtn) {
    settingsSaveBtn.addEventListener('click', () => {
      const model = modelSelect.value;
      
      const settingsToSave = { 
        model,
        lastUpdated: new Date().toISOString()
      };
      
      console.log('🔍 Popup: Saving LLM settings:', {
        model: settingsToSave.model
      });
      
      chrome.storage.local.set({ 
        llmSettings: settingsToSave
      }, () => {
        console.log('🔍 Popup: Settings saved successfully');
        settingsModal.style.display = 'none';
        // Update configuration status after saving
        updateConfigurationStatus();
      });
    });
  }

  // Function to fetch and display user credits
  async function fetchAndDisplayCredits() {
    try {
      // Get the Essence Scholar API key from storage
      const result = await chrome.storage.local.get(['essenceScholarApiKey']);
      const apiKey = result.essenceScholarApiKey;
      
      console.log('API key from storage:', apiKey ? 'Found' : 'Not found');
      console.log('API key length:', apiKey ? apiKey.length : 0);
      
      if (!apiKey) {
        console.log('No API key found, hiding credit display');
        document.getElementById('credit-display').style.display = 'none';
        return;
      }
      
      // Get backend URL
      const backend = await BackendManager.getCurrentBackend();
      if (!backend) {
        console.log('No backend available for credit fetch');
        return;
      }
      
      console.log('Using backend:', backend.name, 'at URL:', backend.url);
      
      // Test backend connectivity first
      try {
        const healthResponse = await fetch(`${backend.url}/health`, { method: 'GET' });
        console.log('Backend health check status:', healthResponse.status);
      } catch (healthError) {
        console.error('Backend health check failed:', healthError);
      }
      
      // Fetch user profile (which includes credits)
      console.log('Fetching credits from:', `${backend.url}/auth/profile`);
      console.log('Using API key:', apiKey ? `${apiKey.substring(0, 10)}...` : 'None');
      
      const response = await fetch(`${backend.url}/auth/profile`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        }
      });
      
      console.log('Response status:', response.status);
      console.log('Response headers:', Object.fromEntries(response.headers.entries()));
      
      if (response.ok) {
        const userData = await response.json();
        console.log('Full user data response:', userData);
        const credits = userData.user?.credits || 0;
        
        // Update credit display
        const creditAmount = document.getElementById('credit-amount');
        const creditDisplay = document.getElementById('credit-display');
        
        if (creditAmount && creditDisplay) {
          creditAmount.textContent = credits;
          creditDisplay.style.display = 'block';
          
          // Add color coding based on credit level
          if (credits > 50) {
            creditAmount.style.color = '#4CAF50'; // Green for high credits
          } else if (credits > 20) {
            creditAmount.style.color = '#FF9800'; // Orange for medium credits
          } else {
            creditAmount.style.color = '#F44336'; // Red for low credits
          }
        }
        
        console.log('Credits updated:', credits);
      } else {
        console.log('Failed to fetch credits:', response.status);
        document.getElementById('credit-display').style.display = 'none';
      }
    } catch (error) {
      console.error('Error fetching credits:', error);
      document.getElementById('credit-display').style.display = 'none';
    }
  }
  
  // Function to clear stale analysis status
  async function clearStaleAnalysisStatus() {
    try {
      const storage = await chrome.storage.local.get([STATUS_KEY]);
      const allStatus = storage[STATUS_KEY] || {};
      let hasChanges = false;

      // Get current time
      const now = new Date().getTime();
      
      // Loop through all statuses and clear any stale ones
      for (const [key, status] of Object.entries(allStatus)) {
        // Convert status timestamps to Date objects
        const startedAt = new Date(status.startedAt).getTime();
        const updatedAt = new Date(status.updatedAt).getTime();
        
        // Clear status if:
        // 1. It's been "in_progress" for more than 5 minutes
        // 2. Last update was more than 5 minutes ago
        const fiveMinutes = 5 * 60 * 1000; // 5 minutes in milliseconds
        if (status.status === 'in_progress' && 
            (now - startedAt > fiveMinutes || now - updatedAt > fiveMinutes)) {
          delete allStatus[key];
          hasChanges = true;
        }
      }

      // Save changes if any statuses were cleared
      if (hasChanges) {
        await chrome.storage.local.set({ [STATUS_KEY]: allStatus });
        console.log('Cleared stale analysis status');
      }
    } catch (error) {
      console.error('Error clearing stale analysis status:', error);
    }
  }

  // === GLOBAL STATE ===
  let UnderAnalysis = 0;
  
  // Function to analyze authors
  async function analyzeAuthors() {
    try {
      console.log('=== AUTHOR ANALYSIS START ===');
      console.log('Popup: analyzeAuthors function called');
      // Get the current active tab
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      console.log('Popup: Current tab:', tab);
      if (!tab.url) {
        throw new Error('No active tab found');
      }
      // Only allow author analysis on SSRN pages (since this is the only option for SSRN)
      if (!tab.url.includes('ssrn.com')) {
        throw new Error('Author analysis is only available on SSRN pages');
      }
      // Start analysis process
      console.log('Popup: Starting author analysis process...');
      setAuthorsButtonState('Analyzing... Do Not Close Extension Popup', true, true);
      showStatus('Extracting authors from the page...', 'progress');
      // Ensure content script is injected and ready
      console.log('Popup: Ensuring content script is injected...');
      await ensureContentScript(tab.id);
      
      // Wait for content script to be ready with retries
      console.log('Popup: Waiting for content script to initialize...');
      let retries = 0;
      const maxRetries = 10;
      let contentScriptReady = false;
      
      while (retries < maxRetries && !contentScriptReady) {
        try {
          await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
          contentScriptReady = true;
          console.log('Popup: Content script is ready');
        } catch (error) {
          retries++;
          console.log(`Popup: Content script not ready yet, retry ${retries}/${maxRetries}`);
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      }
      
      if (!contentScriptReady) {
        throw new Error('Content script failed to initialize after multiple attempts');
      }
      
      // Request content from the content script to get authors
      console.log('Popup: Requesting content from content script...');
      let response;
      try {
        response = await chrome.tabs.sendMessage(tab.id, { action: 'getPaperContent' });
        console.log('Popup: Content script response:', response);
      } catch (error) {
        console.error('Popup: Failed to communicate with content script:', error);
        throw new Error('Could not communicate with content script. Please try refreshing the page.');
      }
      
      if (!response) {
        throw new Error('No response received from content script');
      }
      
      if (response.error) {
        console.log('Popup: Content script returned error:', response.error);
        throw new Error(response.error);
      }
      
      if (!response.content) {
        console.log('Popup: No content received from content script');
        throw new Error('No content received from the page');
      }
      // Extract authors and affiliations
      const authors = response.content.authors || [];
      const affiliations = response.content.affiliations || [];
      console.log('Popup: Raw extracted content:', {
        title: response.content.title,
        authors: authors,
        affiliations: affiliations,
        hasTitle: !!response.content.title,
        hasAbstract: !!response.content.abstract,
        hasPdf: !!response.content.hasPdf,
        pageUrl: tab.url
      });
      if (authors.length === 0) {
        // Provide detailed debugging information
        const debugInfo = `
No authors found on this SSRN page.

Page: ${tab.url}
Title found: ${response.content.title ? 'Yes' : 'No'}
Abstract found: ${response.content.abstract ? 'Yes' : 'No'}
PDF available: ${response.content.hasPdf ? 'Yes' : 'No'}

This could happen if:
1. The page is still loading - try refreshing and waiting
2. The page structure has changed - SSRN may have updated their layout
3. This is not a paper details page - make sure you're on a paper abstract page
4. Authors are dynamically loaded - try scrolling down or waiting a moment

To troubleshoot:
1. Refresh the page and wait for it to fully load
2. Make sure you're on an SSRN paper abstract page (not search results)
3. Try opening the developer console (F12) to see detailed extraction logs
4. Check if authors are visible on the page manually

If the issue persists, this may be a compatibility issue with the current SSRN page structure.`;

        throw new Error(debugInfo);
      }
      console.log('Popup: Found authors:', authors);
      console.log('Popup: Found affiliations:', affiliations);
      showStatus(`Found ${authors.length} authors. Analyzing their profiles and publications...`, 'progress');
      try {
        // Use global backend
        const backend = await BackendManager.getCurrentBackend();
        if (!backend) throw new Error('No backend available');
        // Call the backend to analyze authors using per-tab backend
        console.log('Popup: Calling author analysis endpoint with per-tab backend...');
        const serverResponse = await makeApiRequestWithBackend(CONFIG.ANALYZE_AUTHORS_ENDPOINT, {
          method: 'POST',
          body: JSON.stringify({ 
            authors: authors,
            affiliations: affiliations
          })
        }, backend);
        console.log('Popup: Backend response received for author analysis');
        if (!serverResponse.ok) {
          const errorText = await serverResponse.text();
          throw new Error(`Backend error: ${serverResponse.status} - ${errorText}`);
        }
        const data = await serverResponse.json();
        if (data.error) {
          throw new Error(data.error);
        }
        console.log('Popup: Author analysis results:', data);
        // Display results
        showStatus('Author analysis complete! View detailed results below.', 'success');
        displayAuthorAnalysisResults(data);
        // Update button state
        setAuthorsButtonState('View Full Analysis', false, false);
        analyzeAuthorsBtn.style.backgroundColor = '#4CAF50';
        analyzeAuthorsBtn.onclick = async () => {
          // Store results and open full page
          const paperId = await extractSsrnIdOrUrl(tab.url);
          chrome.storage.local.set({
            lastAuthorAnalysis: {
              timestamp: new Date().toISOString(),
              paperId: paperId,
              data: data
            }
          });
          const unifiedId = await extractSsrnIdOrUrl(tab.url);
          if (unifiedId) {
            // Use paperID approach for author view
            const fullpageUrl = buildPaperIdUrl(unifiedId, { view: 'authors' });
          chrome.tabs.create({ url: fullpageUrl });
          } else {
            // Fallback to basic author view
            const fullpageUrl = chrome.runtime.getURL('fullpage.html') + '?view=authors';
            chrome.tabs.create({ url: fullpageUrl });
          }
        };
      } catch (error) {
        console.error('Error calling author analysis backend:', error);
        throw new Error(`Failed to analyze authors: ${error.message}`);
      }
    } catch (error) {
      console.error('Error in author analysis:', error);
      showStatus(`Error: ${error.message}`, 'error');
      setAuthorsButtonState('Analyze Authors', false, false);
      analyzeAuthorsBtn.style.backgroundColor = '#9C27B0';
    }
  }

  // Function to display author analysis results - REMOVED DUPLICATE (kept final version at end of file)

  // Function to display analysis results - REMOVED DUPLICATE (kept final version at end of file)

  // Function to check if analysis exists on backend - REMOVED DUPLICATE (kept final version at end of file)

  // Function to check analysis status first, then completed analysis if needed - REMOVED DUPLICATE (kept final version at end of file)

  /**
   * Update the popup UI according to the following logic:
   * 1) If page is an SSRN url with paperID, and not a PDF > only show the Analyze Authors button
   * 2) If page is an SSRN url with paperID, and not a PDF, but GET /analysis/paperID returns 200 > show View Analysis and Analyze Authors
   * 3) If page is a PDF and /analysis/paperID is not 200 > only show the analyze-btn option
   * 4) If page is a PDF and GET /analysis/paperID returns 200 > show View Analysis
   * 5) If page is a PDF and /analysis/paperID is not 200 and user clicked on analyze-btn > set UnderAnalysis = 1, show (Analyzing...) to user
   * Once /analysis/paperID is 200, UnderAnalysis is again 0 and depending on the above scenarios, users see the popup
   */
  async function updatePopupUI() {
    // Show loading state initially
    updateBackendLoadingState(true, 'Connecting to backend...');
    const analyzeBtn = document.getElementById('analyze-btn');
    const analyzeAuthorsBtn = document.getElementById('analyze-authors-btn');
    
    if (analyzeBtn) analyzeBtn.style.display = 'none';
    if (analyzeAuthorsBtn) analyzeAuthorsBtn.style.display = 'none';
    
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) {
      updateBackendLoadingState(false);
      showStatus('No active tab found', 'error');
      return;
    }
    
    const url = tab.url;
    const paperId = await extractSsrnIdOrUrl(url);
    const pdfCheckResult = await checkIfPDFPage(tab);
    const isPDF = pdfCheckResult.isPDF;
    const isAccessible = pdfCheckResult.accessible;
    
    const isSSRN = url.includes('ssrn.com') && paperId && !isPDF;
    
    // Update loading message while checking backend
    updateBackendLoadingState(true, 'Checking backend availability...');
    
    // Use global backend detection instead of per-tab
    let backend = await BackendManager.getCurrentBackend();
    
    if (!backend) {
      updateBackendLoadingState(false);
      displayBackendStatus('❌ Backend Unavailable');
      showStatus('Unable to connect to the analysis backend. Please check your internet connection or try again later.', 'error');
      setButtonState('Deep Read!', true, false);
      analyzeBtn.style.backgroundColor = '#ccc';
      analyzeBtn.style.display = 'block';
      return;
    }
    
    // Backend is available - hide loading and proceed with UI setup
    updateBackendLoadingState(false);
    displayBackendStatus('✅ Backend Connected');
    
    let analysisStatus = { inProgress: false, hasCompleted: false };
    
    // Check if paper exists in backend (simple check)
    if (paperId) {
      try {
        updateBackendLoadingState(true, 'Checking for existing analysis...');
        const { exists, error } = await hasAnalysisOnBackend(paperId);
        if (exists) {
          analysisStatus.hasCompleted = true;
        } else if (error) {
          showStatus(error, 'warning');
          // Still allow analysis if there's just a connection error
          analysisStatus.hasCompleted = false;
        } else {
          analysisStatus.hasCompleted = false;
        }
      } catch (error) {
        console.error('Error checking paper existence:', error);
        showStatus('An unexpected error occurred while checking paper status', 'warning');
        analysisStatus.hasCompleted = false;
      } finally {
        // Hide loading state after check is complete
        updateBackendLoadingState(false);
      }
    }
        
    // Hide all buttons initially
    showAuthorsButton(false);
    setButtonState('Deep Read!', true, false);
    analyzeBtn.style.display = 'none';
    if (typeof analyzeAuthorsBtn !== 'undefined') analyzeAuthorsBtn.style.display = 'none';

    // SSRN page with paperID, not PDF
    if (isSSRN) {
      analyzeBtn.style.display = 'block';
      showAuthorsButton(false); // Hide authors button for now (can be enabled later if needed)
      
      if (analysisStatus.hasCompleted) {
        // Show View Paper Page button for completed analysis
        setButtonState('View Paper Page', false, false);
        analyzeBtn.style.backgroundColor = '#4CAF50';
        analyzeBtn.onclick = async () => {
          const fullpageUrl = buildPaperIdUrl(paperId);
          chrome.tabs.create({ url: fullpageUrl });
        };
        showStatus('Analysis exists for this paper! Click "View Paper Page" to see results.', 'success');
      } else {
        // Show disabled analyze button for SSRN pages (PDF analysis not supported on SSRN HTML pages)
        setButtonState('Deep Read!', true, false);
        analyzeBtn.style.backgroundColor = '#ccc';
        showStatus('SSRN page detected. Navigate to the PDF version to analyze content.', 'info');
      }
      return;
    }

    // PDF page - simplified three-state button logic
    if (isPDF) {
      // Generate paperId if not already available (for non-SSRN PDFs)
      if (!paperId) {
        paperId = await SharedIdGenerator.generateIdFromUrl(url);
      }
      
      analyzeBtn.style.display = 'block';
      showAuthorsButton(false); // Hide authors button for PDFs
      
      // Check if analysis already exists
      if (analysisStatus.hasCompleted) {
        // STATE 3: Green "View Results" button
        setButtonState('View Results', false, false);
        analyzeBtn.style.backgroundColor = '#4CAF50';
        analyzeBtn.onclick = async () => {
          const fullpageUrl = buildPaperIdUrl(paperId);
          chrome.tabs.create({ url: fullpageUrl });
        };
        showStatus('Analysis completed. Click "View Results" to see the summary.', 'success');
        return;
      }
      
      // Check if currently analyzing
      let analyzingKey = getAnalyzingKey(tab.id, paperId);
      let analyzingObj = await chrome.storage.local.get([analyzingKey]);
      let isAnalyzing = analyzingObj[analyzingKey] === true;
      
      if (analysisStatus.inProgress || isAnalyzing) {
        // Analysis in progress - orange button
        setButtonState('Analyzing...', true, true);
        analyzeBtn.style.backgroundColor = '#FF9800';
        showStatus('Analysis in progress...', 'progress');
        monitorAnalysisProgress(tab.id, paperId, true);
        return;
      }
      
      // If accessibility couldn't be confirmed (CORS/viewer), still allow analysis for web PDFs
      if (!isAccessible) {
        const likelyAccessible = url.startsWith('http') || url.startsWith('https');
        const isSSRNDownload = url.includes('download.ssrn.com') || url.includes('response-content-disposition=inline') || url.includes('X-Amz-');
        if (likelyAccessible || isSSRNDownload) {
          // Allow proceeding; backend/background will fetch bytes
          showStatus('PDF detected but direct access is restricted. You can still click Deep Read — the backend will attempt to download it.', 'warning');
        } else {
          // Keep previous disabled behavior for known restricted providers
          setButtonState('Deep Read!', true, false);
          analyzeBtn.style.backgroundColor = '#ccc';
          analyzeBtn.style.cursor = 'not-allowed';
          analyzeBtn.onclick = null;
          showStatus('PDF detected but content is not accessible for analysis. Try downloading the PDF or opening it in a new tab first.', 'warning');
          return;
        }
      }
      
      // STATE 1: Active "Deep Read!" button
      setButtonState('Deep Read!', false, false);
      analyzeBtn.style.backgroundColor = '#2196F3';
      analyzeBtn.style.cursor = 'pointer';
      showStatus('PDF ready for analysis. Click "Deep Read!" to start.', 'info');
      
      analyzeBtn.onclick = async () => {
          // Set persistent analyzing state
          let key = getAnalyzingKey(tab.id, paperId);
          await chrome.storage.local.set({ [key]: true });
          UnderAnalysis = 1;
          
          try {
            // Step 1: Generate paperID from URL using SharedIdGenerator
            showStatus('Generating paper ID from URL...', 'info');
            setButtonState('Checking...', true, false);
            analyzeBtn.style.backgroundColor = '#FF9800';

            const actualPaperId = await SharedIdGenerator.generateIdFromUrl(tab.url);
            console.log('[POPUP] Generated paperId from URL:', actualPaperId);
            
            if (!actualPaperId) {
              throw new Error('Could not generate paper ID from URL');
            }

            // Step 2: Check if paper already exists using /storage/paper/{paperID}
            showStatus('Checking if paper exists in database...', 'info');
            
            const backend = await BackendManager.getCurrentBackend();
            if (!backend) {
              throw new Error('No backend available');
            }

            const paperExistsResponse = await fetch(`${backend.url}/storage/paper/${encodeURIComponent(actualPaperId)}`, {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json'
              }
            });
            
            if (paperExistsResponse.ok) {
              // Paper exists - show View Paper Page button immediately
              const paperData = await paperExistsResponse.json();
              showStatus(`Paper "${paperData.title}" already exists! Click "View Paper Page" to see analysis.`, 'success');
              setButtonState('View Paper Page', false, false);
              analyzeBtn.style.backgroundColor = '#4CAF50';
              analyzeBtn.onclick = async () => {
                const fullpageUrl = buildPaperIdUrl(actualPaperId);
                chrome.tabs.create({ url: fullpageUrl });
              };
              
              // Clear analyzing state since we're not analyzing
              await chrome.storage.local.remove(key);
              UnderAnalysis = 0;
              return;
            }

            // Step 3: Paper doesn't exist - proceed with PDF upload/analysis
            showStatus('New paper detected. Starting analysis...', 'info');
            await setAnalysisStatus(actualPaperId, 'in_progress');
            setButtonState('Analyzing... Do Not Close Extension Popup', true, true);
            analyzeBtn.style.backgroundColor = '#FF9800';

            // Get current settings
            const settings = await chrome.storage.local.get(['llmSettings', 'userSettings']);
            const selectedModel = settings.llmSettings?.model || 'gemini-3-flash-preview';
            const userScholarUrl = settings.userSettings?.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en';
            const researchInterests = settings.userSettings?.researchInterests || '';
            const llmSettings = settings.llmSettings || { model: 'gemini-3-flash-preview' };

            // Step 4: Check if this is a local file or web URL
            let fileContentB64 = null;
            const isLocalFile = tab.url.startsWith('file://');
            
            if (isLocalFile) {
              // For local files, try to read the file content
            try {
                showStatus('Reading local PDF file...', 'info');
              const resp = await fetch(tab.url);
              const blob = await resp.blob();
              const arrayBuf = await blob.arrayBuffer();
              const uint8Array = new Uint8Array(arrayBuf);
              
                // Convert to base64 in chunks
              let binary = '';
              const chunkSize = 0x8000; // 32KB chunks
              for (let i = 0; i < uint8Array.length; i += chunkSize) {
                const chunk = uint8Array.subarray(i, i + chunkSize);
                binary += String.fromCharCode.apply(null, chunk);
              }
              fileContentB64 = btoa(binary);
                showStatus('Local PDF file read successfully. Starting analysis...', 'info');
            } catch (e) {
                console.warn('Could not read local PDF file:', e);
                showStatus('Could not read local PDF file. Please try uploading from fullpage interface.', 'error');
                throw new Error('Could not read local PDF file');
              }
            } else {
              // For web URLs: if SSRN signed link, skip content-script reading and let backend/background fetch
              const isSignedSSRN = tab.url.includes('download.ssrn.com') || tab.url.includes('X-Amz-') || tab.url.includes('AWS4-HMAC-SHA256');
              if (isSignedSSRN) {
                showStatus('PDF is served via a signed link. The backend will download it directly.', 'info');
                fileContentB64 = null; // force backend download path
              } else {
              // For web URLs, try to read the PDF via content script first
              try {
                showStatus('Reading PDF from page context...', 'info');
                
                // Function to try reading PDF with retries
                const tryReadPDFWithRetries = async (maxRetries = 3) => {
                  for (let attempt = 1; attempt <= maxRetries; attempt++) {
                    try {
                      console.log(`[PDF Reading] Attempt ${attempt}/${maxRetries} to read PDF via content script`);
                      console.log('[PDF Reading] Current tab URL:', tab.url);
                      
                      // First check if content script is available
                      console.log('[PDF Reading] Checking if content script is available...');
                      let pingResponse;
                      try {
                        pingResponse = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
                        console.log('[PDF Reading] Ping response:', pingResponse);
                      } catch (pingError) {
                        console.log('[PDF Reading] Content script not injected, attempting to inject...');
                        
                        // Check if URL is accessible for content script injection
                        if (window.PDFHandler && window.PDFHandler.isUrlAccessibleForContentScript && 
                            !window.PDFHandler.isUrlAccessibleForContentScript(tab.url)) {
                          throw new Error(`Cannot inject content script into ${tab.url.split('://')[0]}:// URL`);
                        }
                        
                        // Try to inject content script programmatically
                        try {
                          await chrome.scripting.executeScript({
                            target: { tabId: tab.id },
                            files: ['content.js']
                          });
                          console.log('[PDF Reading] Content script injected successfully');
                          
                          // Wait a moment for initialization
                          await new Promise(resolve => setTimeout(resolve, 500));
                          
                          // Try ping again
                          pingResponse = await chrome.tabs.sendMessage(tab.id, { action: 'ping' });
                          console.log('[PDF Reading] Ping response after injection:', pingResponse);
                        } catch (injectionError) {
                          console.error('[PDF Reading] Failed to inject content script:', injectionError);
                          throw new Error(`Could not inject content script: ${injectionError.message}`);
                        }
                      }
                      
                      if (!pingResponse || pingResponse.status !== 'ok') {
                        throw new Error(`Content script not available - ping response: ${JSON.stringify(pingResponse)}`);
                      }
                      
                      // First verify this is actually a PDF page
                      console.log('[PDF Reading] Checking PDF status...');
                      
                      // Check if PDF collector has detected this as PDF
                      let pdfStatusResponse = null;
                      if (window.currentPdfInfo) {
                        pdfStatusResponse = {
                          isPDF: true,
                          canAccess: !window.currentPdfInfo.fallback,
                          source: 'pdf-collector'
                        };
                        console.log('[PDF Reading] Using PDF collector status:', pdfStatusResponse);
                      } else {
                        // Fallback to legacy content script check
                        try {
                          pdfStatusResponse = await chrome.tabs.sendMessage(tab.id, { action: 'checkPDFStatus' });
                          console.log('[PDF Reading] Legacy PDF status response:', pdfStatusResponse);
                        } catch (e) {
                          console.log('[PDF Reading] Could not get PDF status from content script');
                        }
                      }
                      
                      if (!pdfStatusResponse?.isPDF) {
                        // If URL suggests PDF but content doesn't match, provide guidance
                        const url = tab.url.toLowerCase();
                        const urlSuggestsPDF = url.includes('.pdf');
                        if (urlSuggestsPDF) {
                          throw new Error('This looks like a PDF link but leads to a different page. You might need to: 1) Log in first, or 2) Click through to the actual PDF viewer.');
                        } else {
                          throw new Error('This page is not detected as a PDF. Please ensure you are on the actual PDF page.');
                        }
                      }
                      
                      // Ask content script to read PDF content with a timeout
                      console.log('[PDF Reading] Requesting PDF content from content script...');
                      const response = await Promise.race([
                        chrome.tabs.sendMessage(tab.id, { action: 'readPDFContent' }),
                        new Promise((_, reject) => 
                          setTimeout(() => reject(new Error('PDF reading timeout after 60 seconds')), 60000)
                        )
                      ]);
                      
                      console.log('[PDF Reading] Content script response:', { 
                        success: response?.success, 
                        hasContent: !!response?.content,
                        contentSize: response?.content?.length,
                        error: response?.error 
                      });
                      
                      if (response && response.success) {
                        console.log('[PDF Reading] Successfully received PDF content from content script');
                        return response;
                      } else {
                        throw new Error(response?.error || 'Content script failed to read PDF');
                      }
                      
                    } catch (attemptError) {
                      console.warn(`[PDF Reading] Attempt ${attempt} failed:`, attemptError.message);
                      console.warn('[PDF Reading] Full error:', attemptError);
                      
                      if (attempt === maxRetries) {
                        throw attemptError;
                      }
                      
                      // Wait before retry (exponential backoff)
                      const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000);
                      console.log(`[PDF Reading] Waiting ${delay}ms before retry...`);
                      await new Promise(resolve => setTimeout(resolve, delay));
                    }
                  }
                };
                
                const response = await tryReadPDFWithRetries();
                fileContentB64 = response.content;
                showStatus(`PDF read successfully (${Math.round(response.size / 1024)} KB). Starting analysis...`, 'info');
                console.log('Successfully read PDF via content script, size:', response.size, 'bytes');
                
              } catch (e) {
                console.warn('Could not read PDF via content script after retries, falling back to backend download:', e);
                
                // Provide specific error messages based on the error type
                if (e.message.includes('looks like a PDF link but leads to a different page') ||
                    e.message.includes('not detected as a PDF') ||
                    e.message.includes('login page') ||
                    e.message.includes('authentication') ||
                    e.message.includes('Not a PDF content type')) {
                  // Show appropriate error message
                  if (e.message.includes('looks like a PDF link but leads to a different page')) {
                    showStatus(e.message, 'error');
                  } else if (e.message.includes('not detected as a PDF')) {
                    showStatus(e.message, 'error');
                  } else if (e.message.includes('login page') || e.message.includes('authentication')) {
                    showStatus('This appears to be a secure PDF requiring login. Please log in to the website first, then try again.', 'error');
                  } else {
                    showStatus('The server returned HTML instead of PDF. This might be a secure document - try logging in to the website first.', 'error');
                  }
                  // Don't fall back to backend in these cases as it will definitely fail
                  fileContentB64 = null;
                  throw new Error('Cannot proceed with analysis: ' + e.message);
                } else {
                  showStatus('PDF read failed. Trying backend download (may fail for secure URLs)...', 'warning');
                  fileContentB64 = null;
                }
              }
              }
            }
            
            // Step 5: Create payload for analysis
            const basePayload = {
              content: { 
                paperUrl: tab.url,
                paperId: actualPaperId,
                isLocalFile: isLocalFile
              },
              model: selectedModel,
              user_scholar_url: userScholarUrl,
              research_interests: researchInterests
            };
            
            // Add file content if available (for local files or successfully read web PDFs)
            if (fileContentB64) {
              basePayload.file_content = fileContentB64;
              console.log('Including PDF content in payload (size:', fileContentB64.length, 'base64 chars)');
            } else {
              console.log('No PDF content available, backend will try to download from URL:', tab.url);
            }
            
            // No API keys needed - backend handles all LLM API keys
            
            // Step 6: Start analysis via streaming endpoint
            showStatus('Starting PDF analysis...', 'info');
            await monitorAnalysisProgress(tab.id, actualPaperId, true);

            // If we don't have PDF content and it's not a local file, verify URL is accessible (skip for SSRN signed links)
            const isSignedSSRNCheck = tab.url.includes('download.ssrn.com') || tab.url.includes('X-Amz-') || tab.url.includes('AWS4-HMAC-SHA256');
            if (!fileContentB64 && !isLocalFile && !isSignedSSRNCheck) {
              try {
                const response = await fetch(tab.url, { method: 'HEAD' });
                if (!response.ok) {
                  throw new Error(`URL returned ${response.status} ${response.statusText}`);
                }
              } catch (error) {
                throw new Error(`Cannot access PDF URL: ${error.message}`);
              }
            }

            const finalEvt = await analyzeWithSmartBackendStream(basePayload, (msg) => {
              // Only show info messages if they don't contain error keywords
              const isError = msg.toLowerCase().includes('error') || 
                            msg.toLowerCase().includes('failed') ||
                            msg.toLowerCase().includes('cannot');
              showStatus(msg, isError ? 'error' : 'info');
            });

            // Step 7: Analysis completed
            await chrome.storage.local.remove(key);
            UnderAnalysis = 0;
            
            await setAnalysisStatus(actualPaperId, 'complete');
            showStatus('Analysis complete! Click "View Paper Page" to see results.', 'success');
            setButtonState('View Paper Page', false, false);
            analyzeBtn.style.backgroundColor = '#4CAF50';
            analyzeBtn.onclick = async () => {
              const fullpageUrl = buildPaperIdUrl(actualPaperId);
              chrome.tabs.create({ url: fullpageUrl });
            };
            
            await stopAnalysisMonitoring(actualPaperId);
          } catch (error) {
            console.error('Error in PDF analysis:', error);
            await chrome.storage.local.remove(key);
            UnderAnalysis = 0;
            
            // Show appropriate error message based on the type of error
            let errorMessage = error.message || 'Unknown error';
            if (errorMessage.includes('Cannot proceed with analysis')) {
              // Don't modify the message, it's already user-friendly
            } else if (errorMessage.includes('Cannot access PDF URL')) {
              errorMessage = `${errorMessage}. Please ensure you are logged in and have access to this document.`;
            } else if (errorMessage.includes('404')) {
              errorMessage = 'The PDF could not be found. Please check if the URL is correct and accessible.';
            } else if (errorMessage.includes('403')) {
              errorMessage = 'Access to this PDF is forbidden. Please ensure you are logged in and have proper permissions.';
            } else if (errorMessage.includes('Failed to fetch')) {
              errorMessage = 'Could not connect to the server. Please check your internet connection.';
            }
            
            showStatus('Analysis failed: ' + errorMessage, 'error');
            setButtonState('Deep Read!', false, false); // Re-enable the button
            analyzeBtn.style.backgroundColor = '#2196F3'; // Reset to blue
            updatePopupUI();
          }
        };
        
        return;
      };

    // Not SSRN, not PDF, or no paperId
    showStatus('Navigate to a PDF file to analyze its content.', 'info');
    setButtonState('Deep Read!', true, false);
    analyzeBtn.style.backgroundColor = '#ccc';
    analyzeBtn.style.display = 'block';
    showAuthorsButton(false);
  }

  // Patch analyzePaper to only fetch /analysis when status is complete
  const originalAnalyzePaper = analyzePaper;
  analyzePaper = async function(...args) {
    // This is now only used for non-PDFs or as a helper
    await originalAnalyzePaper.apply(this, args);
  };

  // Patch message listener for analysisComplete to reset UnderAnalysis
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'analysisComplete') {
      UnderAnalysis = 0;
      updatePopupUI();
    }
  });

  // Simplified cleanup function
  async function cleanupStaleAnalyzingStates() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;
      
      const paperId = await extractSsrnIdOrUrl(tab.url);
      if (!paperId) return;
      
      // Simple cleanup - just remove any stale analyzing states
      const analyzingKey = getAnalyzingKey(tab.id, paperId);
      await chrome.storage.local.remove(analyzingKey);
      console.log('Cleaned up analyzing state for tab:', tab.id, 'paper:', paperId);
    } catch (error) {
      console.error('Error during cleanup:', error);
    }
  }

  // PDF Detection Diagnostics Tool
  async function runPDFDiagnostics(tab) {
    console.log('========== PDF DIAGNOSTICS START ==========');
    const diagnostics = {
      timestamp: new Date().toISOString(),
      tabInfo: {
        id: tab.id,
        url: tab.url,
        title: tab.title,
        status: tab.status
      },
      checks: []
    };
    
    // Check 1: URL Analysis
    const urlCheck = {
      name: 'URL Analysis',
      passed: false,
      details: {}
    };
    
    const url = tab.url.toLowerCase();
    urlCheck.details.protocol = new URL(tab.url).protocol;
    urlCheck.details.hasPdfExtension = url.endsWith('.pdf');
    urlCheck.details.hasPdfInPath = url.includes('/pdf/') || url.includes('pdf.');
    urlCheck.details.hasPdfQuery = url.includes('pdf=') || url.includes('type=pdf');
    urlCheck.details.isLocalFile = tab.url.startsWith('file://');
    urlCheck.details.isDataUrl = tab.url.startsWith('data:');
    urlCheck.passed = urlCheck.details.hasPdfExtension || urlCheck.details.isLocalFile;
    diagnostics.checks.push(urlCheck);
    
    // Check 2: Title Analysis
    const titleCheck = {
      name: 'Title Analysis',
      passed: false,
      details: {}
    };
    
    const title = (tab.title || '').toLowerCase();
    titleCheck.details.hasPdfExtension = title.includes('.pdf');
    titleCheck.details.hasPdfViewer = title.includes('pdf viewer') || title.includes('pdf.js');
    titleCheck.details.hasAdobeReader = title.includes('adobe');
    titleCheck.details.hasChromeViewer = title.includes('pdf') && title.includes('chrome');
    titleCheck.passed = Object.values(titleCheck.details).some(v => v);
    diagnostics.checks.push(titleCheck);
    
    // Check 3: Content Script Availability
    const contentScriptCheck = {
      name: 'Content Script',
      passed: false,
      details: {}
    };
    
    try {
      const pingResponse = await chrome.tabs.sendMessage(tab.id, 
        { action: 'ping' }, 
        { frameId: 0 }
      );
      contentScriptCheck.details.available = true;
      contentScriptCheck.details.response = pingResponse;
      contentScriptCheck.passed = pingResponse?.status === 'ok';
    } catch (error) {
      contentScriptCheck.details.available = false;
      contentScriptCheck.details.error = error.message;
      
      // Try to inject (check URL accessibility first)
      try {
        if (window.PDFHandler && window.PDFHandler.isUrlAccessibleForContentScript && 
            !window.PDFHandler.isUrlAccessibleForContentScript(tab.url)) {
          throw new Error(`Cannot inject content script into ${tab.url.split('://')[0]}:// URL`);
        }
        
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        contentScriptCheck.details.injectionAttempt = 'success';
      } catch (injectError) {
        contentScriptCheck.details.injectionAttempt = 'failed';
        contentScriptCheck.details.injectionError = injectError.message;
      }
    }
    diagnostics.checks.push(contentScriptCheck);
    
    // Check 4: PDF Detection via Content Script
    const pdfDetectionCheck = {
      name: 'PDF Detection',
      passed: false,
      details: {}
    };
    
    if (contentScriptCheck.passed) {
      try {
        const pdfStatus = await chrome.tabs.sendMessage(tab.id, 
          { action: 'checkPDFStatus' }, 
          { frameId: 0 }
        );
        pdfDetectionCheck.details = pdfStatus;
        pdfDetectionCheck.passed = pdfStatus?.isPDF === true;
      } catch (error) {
        pdfDetectionCheck.details.error = error.message;
      }
    } else {
      pdfDetectionCheck.details.skipped = 'Content script not available';
    }
    diagnostics.checks.push(pdfDetectionCheck);
    
    // Check 5: Background Script Detection
    const backgroundCheck = {
      name: 'Background Detection',
      passed: false,
      details: {}
    };
    
    try {
      const bgResponse = await chrome.runtime.sendMessage({
        action: 'checkPDFStatus',
        tabId: tab.id
      });
      backgroundCheck.details = bgResponse;
      backgroundCheck.passed = bgResponse?.isPDF === true;
    } catch (error) {
      backgroundCheck.details.error = error.message;
    }
    diagnostics.checks.push(backgroundCheck);
    
    // Check 6: HTTP Headers (if not local file)
    const headersCheck = {
      name: 'HTTP Headers',
      passed: false,
      details: {}
    };
    
    if (!tab.url.startsWith('file://') && !tab.url.startsWith('data:')) {
      try {
        const response = await fetch(tab.url, { 
          method: 'HEAD',
          credentials: 'include'
        });
        
        headersCheck.details.status = response.status;
        headersCheck.details.contentType = response.headers.get('content-type');
        headersCheck.details.contentDisposition = response.headers.get('content-disposition');
        headersCheck.details.contentLength = response.headers.get('content-length');
        headersCheck.passed = headersCheck.details.contentType?.includes('pdf') || false;
      } catch (error) {
        headersCheck.details.error = error.message;
        headersCheck.details.cors = error.message.includes('CORS');
      }
    } else {
      headersCheck.details.skipped = 'Local or data URL';
      headersCheck.passed = true; // Local files don't need header check
    }
    diagnostics.checks.push(headersCheck);
    
    // Check 7: PDF Content Reading
    const contentReadCheck = {
      name: 'Content Reading',
      passed: false,
      details: {}
    };
    
    try {
      const readResult = await window.PDFHandler.readPDFContent(tab);
      contentReadCheck.details.success = readResult.success;
      contentReadCheck.details.method = readResult.method;
      contentReadCheck.details.size = readResult.size;
      contentReadCheck.details.error = readResult.error;
      contentReadCheck.passed = readResult.success;
    } catch (error) {
      contentReadCheck.details.error = error.message;
    }
    diagnostics.checks.push(contentReadCheck);
    
    // Calculate overall status
    const passedChecks = diagnostics.checks.filter(c => c.passed).length;
    const totalChecks = diagnostics.checks.length;
    diagnostics.overallStatus = {
      passed: passedChecks,
      total: totalChecks,
      percentage: Math.round((passedChecks / totalChecks) * 100),
      isPDF: passedChecks >= 3, // At least 3 checks should pass
      canAnalyze: contentReadCheck.passed || headersCheck.passed
    };
    
    // Generate recommendations
    diagnostics.recommendations = [];
    
    if (!urlCheck.passed && !titleCheck.passed) {
      diagnostics.recommendations.push('This does not appear to be a PDF file based on URL and title.');
    }
    
    if (!contentScriptCheck.passed) {
      diagnostics.recommendations.push('Content script injection failed. Try refreshing the page.');
    }
    
    if (headersCheck.details.status === 403 || headersCheck.details.status === 401) {
      diagnostics.recommendations.push('PDF requires authentication. Please log in to the website.');
    }
    
    if (headersCheck.details.cors) {
      diagnostics.recommendations.push('CORS restrictions detected. The PDF might still be analyzable.');
    }
    
    if (!contentReadCheck.passed && headersCheck.passed) {
      diagnostics.recommendations.push('PDF detected but cannot be read directly. Backend download might work.');
    }
    
    // Log results
    console.log('PDF Diagnostics Results:');
    console.log('Overall Status:', diagnostics.overallStatus);
    console.log('Checks:');
    diagnostics.checks.forEach(check => {
      console.log(`  ${check.passed ? '✓' : '✗'} ${check.name}:`, check.details);
    });
    console.log('Recommendations:', diagnostics.recommendations);
    console.log('========== PDF DIAGNOSTICS END ==========');
    
    return diagnostics;
  }

  // Helper function to display diagnostics in popup UI
  function displayPDFDiagnostics(diagnostics) {
    const statusContainer = document.getElementById('status-container');
    if (!statusContainer) return;
    
    let html = `
      <div style="background: #f5f5f5; padding: 10px; border-radius: 4px; margin: 10px 0; font-size: 12px;">
        <h4 style="margin: 0 0 8px 0;">PDF Detection Diagnostics</h4>
        <div style="margin-bottom: 8px;">
          <strong>Overall:</strong> ${diagnostics.overallStatus.passed}/${diagnostics.overallStatus.total} checks passed
          ${diagnostics.overallStatus.isPDF ? '✓ PDF Detected' : '✗ Not a PDF'}
        </div>
        <div style="margin-bottom: 8px;">
          <strong>Checks:</strong>
          <ul style="margin: 4px 0; padding-left: 20px;">
    `;
    
    diagnostics.checks.forEach(check => {
      const icon = check.passed ? '✓' : '✗';
      const color = check.passed ? 'green' : 'red';
      html += `<li style="color: ${color};">${icon} ${check.name}</li>`;
    });
    
    html += `
          </ul>
        </div>
    `;
    
    if (diagnostics.recommendations.length > 0) {
      html += `
        <div>
          <strong>Recommendations:</strong>
          <ul style="margin: 4px 0; padding-left: 20px;">
      `;
      diagnostics.recommendations.forEach(rec => {
        html += `<li>${rec}</li>`;
      });
      html += `
          </ul>
        </div>
      `;
    }
    
    html += `</div>`;
    
    statusContainer.innerHTML = html;
  }

  // Replace initialization to use updatePopupUI
  async function initializePopup() {
    try {
      displayBackendStatus('🔍 Checking Backend...');
      
      // Show loading state immediately
      updateBackendLoadingState(true, 'Initializing...');
      
      // Start backend detection asynchronously and update UI immediately
      const backendPromise = BackendManager.getCurrentBackend();
      
      // Reset UnderAnalysis on popup initialization (handles tab refresh case)
      UnderAnalysis = 0;
      window.clickedAnalyzeThisSession = false;
      
      // Check for stale analyzing states and clean them up
      await cleanupStaleAnalyzingStates();
      
      // Wait for backend detection to complete
      const backend = await backendPromise;
      if (backend) {
        displayBackendStatus('✅ Backend Connected');
      } else {
        displayBackendStatus('❌ No Backend Available');
      }
      
      await updateBackendStatusDisplay(backend);
      await updatePopupUI();
    } catch (error) {
      console.error('Popup: Initialization error:', error);
      displayBackendStatus('❌ Backend Error');
      updateBackendStatusDisplay(null, error.message);
    }
  }
  
  // Run initialization
  initializePopup();
  updateConfigurationStatus();
  

  
  // Also update UI when popup is focused (in case user switches tabs)
  window.addEventListener('focus', async () => {
    try {
      await updatePopupUI(); // Use the main UI function instead of checkPageType
    } catch (error) {
      console.error('Error updating UI on focus:', error);
    }
  });

  // Add keyboard shortcut for PDF diagnostics (Ctrl+Shift+D)
  document.addEventListener('keydown', async (e) => {
    if (e.ctrlKey && e.shiftKey && e.key === 'D') {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab) {
        const diagnostics = await runPDFDiagnostics(tab);
        displayPDFDiagnostics(diagnostics);
      }
    }
  });

  // Listen for runtime messages (e.g., from background script)
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('Popup received message:', message);
    
    if (message.action === 'analysisComplete') {
      console.log('Analysis completion notification received');
      
      // Reset analysis state
      UnderAnalysis = 0;
      
      // Clear analyzing state for this tab/paper if available
              chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (tabs && tabs.length > 0) {
          const tab = tabs[0];
          const paperId = await extractSsrnIdOrUrl(tab.url);
          if (paperId && message.tabId === tab.id) {
            const analyzingKey = getAnalyzingKey(tab.id, paperId);
            await chrome.storage.local.remove(analyzingKey);
            console.log('Cleared analyzing state on completion:', analyzingKey);
          }
        }
      });
      
      // Update UI to show completion
      updatePopupUI();
      
      sendResponse({ received: true });
    } else if (message.action === 'showUpdateMessage') {
      console.log('Showing extension update message');
      showStatus('⚠️ Extension Update Required - Please update from Chrome Web Store', 'error');
      
      // Show a more prominent message
      const statusDiv = document.getElementById('status');
      if (statusDiv) {
        statusDiv.innerHTML = `
          <div style="background: #ffebee; border: 2px solid #f44336; border-radius: 8px; padding: 15px; margin: 10px 0; text-align: center;">
            <div style="font-weight: bold; color: #d32f2f; margin-bottom: 8px;">⚠️ Extension Update Required</div>
            <div style="color: #d32f2f; font-size: 14px; margin-bottom: 10px;">
              Your extension needs to be updated to work with the latest backend.
            </div>
            <button onclick="window.open('https://chrome.google.com/webstore/detail/essence-scholar/your-extension-id', '_blank')" 
                    style="background: #d32f2f; color: white; border: none; padding: 8px 16px; border-radius: 4px; cursor: pointer;">
              Update Extension
            </button>
          </div>
        `;
      }
      
      sendResponse({ received: true });
      hideProgress();
      setButtonState('View Paper Page', false, false);
      analyzeBtn.style.backgroundColor = '#4CAF50';
      showStatus('Analysis completed successfully! Click "View Paper Page" to see results.', 'success');
      
      // Update button onclick to view results
      analyzeBtn.onclick = async () => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tab || !tab.url) return;
        const paperId = await extractSsrnIdOrUrl(tab.url);
        const fullpageUrl = buildPaperIdUrl(paperId);
        chrome.tabs.create({ url: fullpageUrl });
      };
      
      sendResponse({ received: true });
    } else if (message.action === 'analysisStarted') {
      console.log('Analysis started notification received');
      
      // Update UI to show analysis in progress and start monitoring
      setButtonState('Analyzing... Do Not Close Extension Popup', true, true);
      showProgress(1, 'Analysis started...');
      
      // Start monitoring for status changes
      setTimeout(() => {
        checkAndMonitorAnalysisStatus();
      }, 1000);
      
      sendResponse({ received: true });
    } else if (message.action === 'analysisProgress') {
      console.log('Analysis progress update received:', message.data);
      
      // Update progress based on backend status
      if (message.data.status === 'in_progress') {
        let latestMessage = 'Analysis in progress...';
        
        // Process logs for detailed progress
        if (message.data.logs && message.data.logs.length > 0) {
          const lastLog = message.data.logs[message.data.logs.length - 1];
          if (lastLog.section) {
            if (lastLog.status === 'junior_start') {
              updateTaskStatus(lastLog.section, 'in_progress');
            } else if (lastLog.status === 'junior_done') {
              updateTaskStatus(lastLog.section, 'done');
            }
          }
          latestMessage = `[${lastLog.section || lastLog.status}] ${lastLog.message}`;
        }
        
        showProgress(2, latestMessage);
      }
      
      sendResponse({ received: true });
    } else if (message.action === 'analysisError') {
      console.log('Analysis error notification received:', message.error);
      
      // Reset analysis state
      UnderAnalysis = 0;
      
      // Clear analyzing state for this tab/paper if available
      chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
        if (tabs && tabs.length > 0) {
          const tab = tabs[0];
          const paperId = await extractSsrnIdOrUrl(tab.url);
          if (paperId && message.tabId === tab.id) {
            const analyzingKey = getAnalyzingKey(tab.id, paperId);
            await chrome.storage.local.remove(analyzingKey);
            console.log('Cleared analyzing state on error:', analyzingKey);
          }
        }
      });
      
      hideProgress();
      showStatus('Analysis failed: ' + (message.error || 'Unknown error'), 'error');
      setButtonState('Deep Read!', false, false);
      analyzeBtn.style.backgroundColor = '#2196F3';
      
      sendResponse({ received: true });
    }
    
    return true; // Keep message channel open for async response
  });

  // Listen for PDF collector messages
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.status === 'ready' && message.pdf) {
      console.log('Popup received PDF ready message:', message.pdf);
      
      // Handle PDF ready notification from collector
      if (message.pdf.fallback) {
        console.log('PDF collection used fallback (URL only)');
        showStatus('PDF detected (fallback mode)', 'info');
      } else {
        console.log('PDF collection successful with bytes');
        showStatus('PDF detected and processed', 'success');
      }
      
      // Update the UI to reflect PDF availability
      updatePopupUI();
      
      sendResponse({ received: true });
      return true;
    }
    
    if (message.action === 'pdfReady') {
      console.log('Popup received pdfReady message for tab:', message.tabId, 'PDF info:', message.pdf);
      
      // Store PDF info for this tab
      window.currentPdfInfo = message.pdf;
      
      // Update UI to show PDF is available
      updatePopupUI();
      
      sendResponse({ received: true });
      return true;
    }
  });


  // Function to display author analysis results
  function displayAuthorAnalysisResults(data) {
    const summary = data.summary;
    const authors = data.authors;

    let resultHtml = `
      <div style="margin-top: 15px; padding: 10px; background-color: #f8f9fa; border-radius: 4px; text-align: left; font-size: 12px;">
        <h3 style="margin: 0 0 10px 0; font-size: 14px; color: #333;">Author Analysis Summary</h3>
        <div><strong>Total Authors:</strong> ${summary.total_authors}</div>
        <div><strong>Total FT50 Publications:</strong> ${summary.total_ft50_publications}</div>
        <div><strong>Total Citations:</strong> ${summary.total_citations.toLocaleString()}</div>
        <div><strong>Highest H-index:</strong> ${summary.max_h_index}</div>
        
        <div style="margin-top: 8px;"><strong>Top Authors:</strong></div>
    `;

    // Show top 2 authors by citations
    const topAuthors = authors
      .filter(author => !author.error)
      .sort((a, b) => b.citations - a.citations)
      .slice(0, 2);

    topAuthors.forEach(author => {
      resultHtml += `
        <div style="margin: 4px 0; padding: 4px; background: white; border-radius: 2px;">
          <div><strong>${author.name}</strong> (${author.affiliation || 'Unknown'})</div>
          <div style="font-size: 11px; color: #666;">
            ${author.citations} citations • H-index: ${author.h_index} • FT50: ${author.ft50_count}
          </div>
        </div>
      `;
    });

    resultHtml += `
        <div style="margin-top: 8px; font-size: 11px; color: #666;">
          Click "View Full Analysis" for complete details, publications, and research areas.
        </div>
      </div>
    `;

    statusContainer.innerHTML = resultHtml;
  }

  // Function to display analysis results
  function displayAnalysis(analysis, tabUrl) {
    if (!analysis) {
      showStatus('No analysis data available', 'error');
      return;
    }

    // Update button state
    setButtonState('View Paper Page', false, false);
    analyzeBtn.style.backgroundColor = '#4CAF50';
    analyzeBtn.onclick = async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !tab.url) return;
      const paperId = await extractSsrnIdOrUrl(tab.url);
      const fullpageUrl = buildPaperIdUrl(paperId);
      chrome.tabs.create({ url: fullpageUrl });
    };

    // Show success message
    let statusMessage = 'Analysis loaded from cache. Click "View Paper Page" to see the detailed summary.';
    if (analysis.data && analysis.data.author_data) {
      statusMessage += ` Author profiles available: ${analysis.data.author_data.summary.total_authors} authors with ${analysis.data.author_data.summary.total_citations.toLocaleString()} total citations.`;
    }
    showStatus(statusMessage, 'success');
  }

  // Function to check if analysis exists on backend
  async function checkAnalysisOnBackend(analysisId) {
    try {
      console.log('Checking backend for analysis with ID:', analysisId);
      
      // Use smart backend detection to get the correct backend
      const backend = await BackendManager.getCurrentBackend();
      if (!backend) {
        console.log('No healthy backend available for checking analysis');
        return false;
      }
      
      const url = `${backend.url}/analysis/${encodeURIComponent(analysisId)}`;
      console.log('Checking analysis endpoint:', url);
      
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      

      
      if (response.ok) {
        const data = await response.json();
        console.log('Found analysis on backend:', data.analysis_id || analysisId);
        return data;
      } else if (response.status === 404) {
        console.log('Analysis not found on backend');
        return false;
      } else {
        console.log('Backend returned error for analysis check:', response.status);
        return false;
      }
    } catch (error) {
      console.error('Error checking analysis on backend:', error);
      return false;
    }
  }

  // Backward-compatible wrapper for UI checks - returns { exists: boolean, error: string | null }
  async function hasAnalysisOnBackend(paperId) {
    try {
      // Simple check: does paper exist in backend?
      const backend = await BackendManager.getCurrentBackend();
      if (!backend) {
        return { exists: false, error: 'No healthy backend available' };
      }
      
      const response = await fetch(`${backend.url}/storage/paper/${encodeURIComponent(paperId)}`, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });
      
      return { exists: response.ok, error: null };
    } catch (error) {
      console.error('Error checking if paper exists:', error);
      let errorMessage = 'Could not connect to backend';
      if (error instanceof TypeError && error.message === 'Failed to fetch') {
        errorMessage = 'Could not connect to backend. Please check your internet connection.';
      }
      return { exists: false, error: errorMessage };
    }
  }

  // DISABLED: checkAnalysisStatusAndCompletion function 
  // This function made unnecessary /analysis-status/ calls to the backend
  // Now we use simple paper existence check via /storage/paper/{paperID}
  async function checkAnalysisStatusAndCompletion(paperId, backend) {
    console.log('checkAnalysisStatusAndCompletion has been disabled - using simple paper existence check instead');
      return { inProgress: false, hasCompleted: false };
  }

  // Listen for tab refresh and reset UnderAnalysis if the current tab is reloaded
  chrome.tabs.onUpdated.addListener(function(tabId, changeInfo, tab) {
    if (changeInfo.status === 'loading') {
      chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
        if (tabs && tabs.length > 0 && tabs[0].id === tabId) {
          UnderAnalysis = 0;
          window.clickedAnalyzeThisSession = false;
        }
      });
    }
  });

  // Utility to get the analyzing key for a tab and paper
  function getAnalyzingKey(tabId, paperId) {
    return `analyzing_${tabId}_${paperId}`;
  }

  // On tab refresh or redirect, clear persistent analyzing state
  chrome.tabs.onUpdated.addListener(async function(tabId, changeInfo, tab) {
    if (changeInfo.status === 'loading') {
      const paperId = tab && tab.url ? await extractSsrnIdOrUrl(tab.url) : null;
      if (paperId) {
        let key = getAnalyzingKey(tabId, paperId);
        chrome.storage.local.remove(key);
      }
      UnderAnalysis = 0;
    }
  });

  // Removed getTabAssignedBackend - now using global BackendManager

  // Patch checkAnalysisOnBackend to accept a backend argument
  async function checkAnalysisOnBackend(paperId, backend) {
    try {
      console.log('Checking backend for analysis of paper:', paperId);
      if (!backend) {
        backend = await BackendManager.getCurrentBackend();
      }
      if (!backend) {
        console.log('No healthy backend available for checking analysis');
        return false;
      }
      const url = `${backend.url}/analysis/${encodeURIComponent(paperId)}`;
      console.log('Checking analysis endpoint:', url);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      if (response.ok) {
        const data = await response.json();
        console.log('Backend has analysis data:', data);
        if (data && data.summary) {
          if (data.summary === 'Error generating analysis' || !data.summary.trim()) {
            console.log('Backend returned error analysis or empty summary:', data.summary);
            return false;
          }
          
          // Generate consistent analysis_id using the same logic as backend
          const settings = await chrome.storage.local.get(['userSettings']);
          const userScholarUrl = settings.userSettings?.googleScholarUrl || 'https://scholar.google.de/citations?user=jgW3WbcAAAAJ&hl=en';
          const generatedAnalysisId = await generateAnalysisId(paperId, userScholarUrl);
          
          const storageKey = `analysis_${paperId}`;
          const analysisResult = {
            timestamp: new Date().toISOString(),
            paperId: paperId,
            analysisId: data.analysis_id || generatedAnalysisId, // Use backend analysis_id or generate consistent one
            content: data.content || {
              paperUrl: `https://papers.ssrn.com/sol3/papers.cfm?abstract_id=${paperId}`,
              paperId: paperId,
              title: 'Paper Analysis',
              abstract: 'Analysis loaded from backend',
              paperContent: 'Content processed by backend'
            },
            summary: data.summary,
            data: data,
            autoAnalyzed: true
          };
          const storageData = {};
          storageData[storageKey] = analysisResult;
          await chrome.storage.local.set(storageData);
          console.log('Stored analysis data from backend');
          await setAnalysisStatus(paperId, 'complete');
        }
        return true;
      } else if (response.status === 404) {
        console.log('No analysis found on backend for paper:', paperId);
        return false;
      } else {
        console.log('Backend returned error for analysis check:', response.status);
        return false;
      }
    } catch (error) {
      console.error('Error checking analysis on backend:', error);
      return false;
    }
  }

  // Patch updateBackendStatusDisplay to accept a backend argument
  async function updateBackendStatusDisplay(backend = null, error = null) {
    const statusDiv = document.getElementById('backend-status');
    if (!statusDiv) return;
    try {
      if (error) {
        statusDiv.innerHTML = `<div class="error">❌ Backend Error<br><small>${error}</small></div>`;
        return;
      }
      if (!backend) {
        backend = await BackendManager.getCurrentBackend();
      }
      if (backend) {
        const start = Date.now();
        try {
          await fetch(`${backend.url}${CONFIG.HEALTH_ENDPOINT}`, {
            method: 'GET',
            signal: AbortSignal.timeout(CONFIG.HEALTH_CHECK_TIMEOUT)
          });
          const latency = Date.now() - start;
          statusDiv.innerHTML = `
            <div class="success">
              ✅ You are using the latest version of the extension.
              <br><small>Connected to ${backend.name} (${latency}ms)</small>
            </div>
          `;
        } catch (error) {
          statusDiv.innerHTML = `
            <div class="success">
              ✅ Using ${backend.name}
              <br><small>${backend.url}</small>
            </div>
          `;
        }
      } else {
        statusDiv.innerHTML = '<div class="error">❌ You must update the extension to the latest version.</div>';
      }
    } catch (error) {
      console.error('Error updating backend status:', error);
      statusDiv.innerHTML = '<div class="error">❌ Backend detection failed, refresh the page.</div>';
    }
  }

  // === Task progress checklist helpers ===
  // Keep an in-memory map of section -> status (in_progress | done)
  const taskStatusMap = {};

  // Ensure a checklist container exists just below the progress bar
  function ensureTaskChecklist() {
    let checklist = document.getElementById('progress-tasks');
    if (!checklist) {
      const progressContainer = document.getElementById('progress-container');
      if (!progressContainer) return null;
      checklist = document.createElement('ul');
      checklist.id = 'progress-tasks';
      checklist.style.listStyle = 'none';
      checklist.style.padding = '6px 12px';
      checklist.style.margin = '0';
      checklist.style.fontSize = '12px';
      progressContainer.parentNode.insertBefore(checklist, progressContainer.nextSibling);
    }
    return checklist;
  }

  function renderTaskChecklist() {
    const checklist = ensureTaskChecklist();
    if (!checklist) return;
    checklist.innerHTML = '';
    Object.entries(taskStatusMap).forEach(([section, status]) => {
      const li = document.createElement('li');
      li.textContent = `${status === 'done' ? '✅' : status === 'in_progress' ? '⏳' : '•'} ${section}`;
      li.style.opacity = status === 'done' ? '0.7' : '1';
      checklist.appendChild(li);
    });
  }

  function updateTaskStatus(section, status) {
    if (!section) return;
    // Only update if status changes or new
    if (taskStatusMap[section] !== status) {
      taskStatusMap[section] = status;
      renderTaskChecklist();
    }
  }

  function resetTaskChecklist() {
    for (const key in taskStatusMap) delete taskStatusMap[key];
    renderTaskChecklist();
  }

  // // Version checking functionality
  // async function checkForUpdates() {
  //   try {
  //     const backend = await BackendManager.getCurrentBackend();
  //     if (!backend) {
  //       console.log('No backend available for version check');
  //       return;
  //     }

  //     // Get extension version from manifest
  //     const manifest = chrome.runtime.getManifest();
  //     const extensionVersion = `v${manifest.version}`;

  //     const response = await fetch(`${backend.url}${CONFIG.VERSION_ENDPOINT}`, {
  //       method: 'GET',
  //       headers: {
  //         'Content-Type': 'application/json',
  //         'X-Extension-Version': extensionVersion
  //       }
  //     });

  //     if (response.ok) {
  //       const versionData = await response.json();
  //       console.log('Version check result:', versionData);

  //       if (versionData.update_available || versionData.deprecated) {
  //         showVersionNotification(versionData);
  //       }
  //     }
  //   } catch (error) {
  //     console.error('Error checking for updates:', error);
  //   }
  // }

  function showVersionNotification(versionData) {
    // Remove any existing version notifications first
    const existingNotification = document.getElementById('version-notification');
    if (existingNotification) {
      existingNotification.remove();
    }

    const notificationContainer = document.createElement('div');
    notificationContainer.id = 'version-notification';
    notificationContainer.style.cssText = `
      margin: 8px 0;
      padding: 8px;
      border-radius: 4px;
      font-size: 12px;
      text-align: left;
      ${versionData.deprecated || versionData.type === 'deprecated' ? 
        'background-color: #fff3cd; border: 1px solid #ffeaa7; color: #856404;' : 
        'background-color: #d1ecf1; border: 1px solid #bee5eb; color: #0c5460;'
      }
    `;

    const isDeprecated = versionData.deprecated || versionData.type === 'deprecated';
    const icon = isDeprecated ? '⚠️' : 'ℹ️';
    const title = isDeprecated ? 'Extension Update Required' : 'Update Available';
    
    notificationContainer.innerHTML = `
      <div style="font-weight: bold; margin-bottom: 4px;">
        ${icon} ${title}
      </div>
      <div style="margin-bottom: 6px;">
        ${versionData.message || 'A newer version is available.'}
      </div>
      <div style="font-size: 11px; color: #666;">
        Current: ${versionData.extension_version || 'Unknown'} → Latest: ${versionData.latest_version || versionData.backend_version || 'Unknown'}
      </div>
    `;

    // Insert notification below backend status
    const backendStatus = document.getElementById('backend-status');
    if (backendStatus && backendStatus.parentNode) {
      backendStatus.parentNode.insertBefore(notificationContainer, backendStatus.nextSibling);
    }
  }

  // Global functions for handling version warnings from API responses
  window.showVersionWarningFromAPI = function(versionWarning) {
    console.log('Received version warning from API:', versionWarning);
    showVersionNotification(versionWarning);
  };

  window.checkResponseForVersionWarning = function(versionWarning) {
    console.log('Checking response for version warning:', versionWarning);
    showVersionNotification(versionWarning);
  };

  // // Initialize version checking
  // setTimeout(() => {
  //   checkForUpdates();
  // }, 2000); // Check for updates 2 seconds after popup loads

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
  
  // Set up credit refresh interval (every 30 seconds)
  setInterval(async () => {
    try {
      await fetchAndDisplayCredits();
    } catch (error) {
      console.error('Error refreshing credits:', error);
    }
  }, 30000); // 30 seconds
});
