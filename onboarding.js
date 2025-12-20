// Onboarding JavaScript
let currentStep = 1;
const totalSteps = 4; // API key, model selection, research profile, analysis preferences

// Initialize onboarding
document.addEventListener('DOMContentLoaded', function() {
  updateProgress();
  setupEventListeners();
  loadExistingSettings();
  // Backend status check removed - not needed for simplified onboarding
});

function setupEventListeners() {
  // Model selection
  document.querySelectorAll('.model-card').forEach(card => {
    card.addEventListener('click', function() {
      document.querySelectorAll('.model-card').forEach(c => c.classList.remove('selected'));
      this.classList.add('selected');
    });
  });
  
  // Navigation buttons
  document.getElementById('nextBtn').addEventListener('click', nextStep);
  document.getElementById('prevBtn').addEventListener('click', prevStep);
  document.getElementById('finishBtn').addEventListener('click', finishSetup);
  document.getElementById('skipBtn').addEventListener('click', skipSetup);
  
  // Old API key validation removed - no longer needed
  
  // Generate profile button
  const generateProfileBtn = document.getElementById('generateProfileBtn');
  if (generateProfileBtn) {
    console.log('✓ Generate profile button found:', generateProfileBtn);
    console.log('Button text:', generateProfileBtn.textContent);
    console.log('Button ID:', generateProfileBtn.id);
    
    // Remove any existing listeners first
    generateProfileBtn.replaceWith(generateProfileBtn.cloneNode(true));
    
    // Get the fresh button reference
    const freshBtn = document.getElementById('generateProfileBtn');
    
    // Add the event listener
    freshBtn.addEventListener('click', function(e) {
      console.log('Generate profile button CLICKED!', e);
      console.log('Event type:', e.type);
      console.log('Button element:', this);
      generateResearchProfile();
    });
    
    // Ensure button is not disabled
    freshBtn.disabled = false;
    freshBtn.removeAttribute('disabled');
    
    console.log('✓ Event listener added to generate profile button');
    console.log('✓ Button enabled:', !freshBtn.disabled);
  } else {
    console.error('X Generate profile button not found!');
    console.log('Available buttons:', document.querySelectorAll('button').length);
    console.log('Button with ID generateProfileBtn:', document.getElementById('generateProfileBtn'));
  }
  
  // API key input validation
  const essenceApiKeyInput = document.getElementById('essenceApiKey');
  if (essenceApiKeyInput) {
    console.log('Setting up API key validation for:', essenceApiKeyInput.id);
    essenceApiKeyInput.addEventListener('input', validateEssenceApiKey);
    // Also validate on blur to catch when user finishes typing
    essenceApiKeyInput.addEventListener('blur', validateEssenceApiKey);
  } else {
    console.error('API key input element not found during setup');
  }
  
  // Test API key button
  const testApiKeyBtn = document.getElementById('testApiKeyBtn');
  if (testApiKeyBtn) {
    testApiKeyBtn.addEventListener('click', testEssenceApiKey);
  }
}

// Backend detection function
async function getBackendUrl() {
  try {
    // Check if BackendManager is available (from popup.js or fullpage.js)
    if (typeof BackendManager !== 'undefined') {
      const backend = await BackendManager.getCurrentBackend();
      if (backend) {
        console.log('Onboarding: Using BackendManager backend:', backend.url);
        return backend.url;
      }
    }
    
    // Fallback: try to get backend from chrome.storage
    const result = await chrome.storage.local.get(['currentBackend']);
    if (result.currentBackend && result.currentBackend.url) {
      console.log('Onboarding: Using stored backend:', result.currentBackend.url);
      return result.currentBackend.url;
    }
    
    // Final fallback: use localhost for development
    console.log('Onboarding: Using fallback localhost backend');
    return 'http://localhost:8080';
  } catch (error) {
    console.error('Onboarding: Error detecting backend, using fallback:', error);
    return 'http://localhost:8080';
  }
}

function updateProgress() {
  const progress = (currentStep / totalSteps) * 100;
  document.getElementById('progressFill').style.width = progress + '%';
}

function nextStep() {
  if (validateCurrentStep()) {
    if (currentStep < totalSteps) {
      hideStep(currentStep);
      currentStep++;
      showStep(currentStep);
      updateProgress();
      updateNavigationButtons();
    }
  }
}

function prevStep() {
  if (currentStep > 1) {
    hideStep(currentStep);
    currentStep--;
    showStep(currentStep);
    updateProgress();
    updateNavigationButtons();
  }
}

function showStep(stepNumber) {
  document.getElementById(`step${stepNumber}`).style.display = 'block';
}

function hideStep(stepNumber) {
  document.getElementById(`step${stepNumber}`).style.display = 'none';
}

function updateNavigationButtons() {
  const prevBtn = document.getElementById('prevBtn');
  const nextBtn = document.getElementById('nextBtn');
  const finishBtn = document.getElementById('finishBtn');
  
  prevBtn.style.display = currentStep > 1 ? 'inline-block' : 'none';
  nextBtn.style.display = currentStep < totalSteps ? 'inline-block' : 'none';
  finishBtn.style.display = currentStep === totalSteps ? 'inline-block' : 'none';
}

function validateCurrentStep() {
  switch (currentStep) {
    case 1:
      return validateEssenceApiKey();
    case 2:
      return validateModelSelection();
    case 3:
      return true; // Research profile is optional
    case 4:
      return validateAnalysisPreferences();
    default:
      return true;
  }
}

function validateModelSelection() {
  const selectedModel = document.querySelector('.model-card.selected');
  if (!selectedModel) {
    alert('Please select an AI model to continue.');
    return false;
  }
  return true;
}

// API key validation function removed - backend handles all API keys

function validateAnalysisPreferences() {
  const selectedResearchers = document.querySelectorAll('input[name="junior_researchers"]:checked');
  if (selectedResearchers.length === 0) {
    alert('Please select at least one analysis preference.');
    return false;
  }
  return true;
}

function loadExistingSettings() {
  // Load existing settings from chrome.storage
  chrome.storage.local.get(['essenceScholarApiKey', 'llmSettings', 'userSettings', 'juniorResearchers'], function(result) {
    const essenceScholarApiKey = result.essenceScholarApiKey || '';
    const llmSettings = result.llmSettings || {};
    const userSettings = result.userSettings || {};
    const juniorResearchers = result.juniorResearchers || {};
    
    // Set Essence Scholar API key
    if (essenceScholarApiKey) {
      const apiKeyInput = document.getElementById('essenceApiKey');
      if (apiKeyInput) {
        apiKeyInput.value = essenceScholarApiKey;
        validateEssenceApiKey(); // Trigger validation
      }
    }
    
    // Set model selection
    if (llmSettings && llmSettings.model) {
      const modelCard = document.querySelector(`[data-model="${llmSettings.model}"]`);
      if (modelCard) {
        modelCard.classList.add('selected');
      }
    }
    
    // API key loading removed - backend handles all API keys
    
    // Set research profile
    if (userSettings.googleScholarUrl) {
      document.getElementById('googleScholarUrl').value = userSettings.googleScholarUrl;
    }
    if (userSettings.researchInterests) {
      document.getElementById('researchInterests').value = userSettings.researchInterests;
    }
    
    // Set analysis preferences
    Object.keys(juniorResearchers).forEach(key => {
      const checkbox = document.querySelector(`input[value="${key}"]`);
      if (checkbox) {
        checkbox.checked = juniorResearchers[key];
      }
    });
  });
}

async function generateResearchProfile() {
  console.log('🚀 generateResearchProfile function called!');
  console.log('Function execution started at:', new Date().toISOString());
  
  try {
    const generateBtn = document.getElementById('generateProfileBtn');
    const generateBtnText = document.getElementById('generateBtnText');
    const generateBtnLoading = document.getElementById('generateBtnLoading');
    const googleScholarUrl = document.getElementById('googleScholarUrl').value.trim();
    const researchInterests = document.getElementById('researchInterests');
    
    console.log('🔍 Elements found:', {
      generateBtn: !!generateBtn,
      generateBtnText: !!generateBtnText,
      generateBtnLoading: !!generateBtnLoading,
      googleScholarUrl: googleScholarUrl,
      researchInterests: !!researchInterests
    });
    
    // Test if we can access the DOM elements
    console.log('📝 Button text content:', generateBtn?.textContent);
    console.log('🔗 URL input value:', googleScholarUrl);
    console.log('📄 Research interests element:', researchInterests?.tagName);
    
    if (!googleScholarUrl) {
    alert('Please enter your Google Scholar profile URL first.');
    return;
  }
  
  // Validate Google Scholar URL
  if (!googleScholarUrl.includes('scholar.google.com') && !googleScholarUrl.includes('scholar.google.de')) {
    alert('Please enter a valid Google Scholar Profile URL');
    return;
  }
  
  // Show loading state
  generateBtn.disabled = true;
  generateBtnText.style.display = 'none';
  generateBtnLoading.style.display = 'inline-block';
  
  try {
    // Get the Essence Scholar API key from chrome storage (where it's actually stored)
    let apiKey = null;
    
    try {
      // Try chrome.storage.sync first (where it's stored during Step 1)
      const result = await new Promise((resolve) => {
        chrome.storage.sync.get(['essence_scholar_api_key'], (result) => {
          resolve(result.essence_scholar_api_key);
        });
      });
      apiKey = result;
      
      // If not found in chrome.storage.sync, try localStorage as fallback
      if (!apiKey) {
        apiKey = localStorage.getItem('essence_scholar_api_key');
      }
      
      console.log('🔑 API key found:', apiKey ? `${apiKey.substring(0, 10)}...` : 'Not found');
      
    } catch (error) {
      console.log('Chrome storage error, trying localStorage...');
      apiKey = localStorage.getItem('essence_scholar_api_key');
    }
    
    if (!apiKey) {
      throw new Error('No Essence Scholar API key found. Please complete Step 1 first.');
    }
    
    // Make API request to generate profile using the existing backend endpoint
    const backendUrl = await getBackendUrl();
    const response = await fetch(`${backendUrl}/generate-research-profile`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        googleScholarUrl: googleScholarUrl,
        researchInterests: researchInterests.value.trim()
      })
    });
    
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error('Invalid API key. Please check your Essence Scholar API key.');
      } else if (response.status === 402) {
        throw new Error('Insufficient credits. Please check your credit balance.');
      } else {
        const errorText = await response.text();
        throw new Error(`Backend error: ${response.status} - ${errorText}`);
      }
    }
    
    const result = await response.json();
    
    if (result.error) {
      throw new Error(result.error);
    }
    
    // Update the research interests field with generated content
    if (result.generatedProfile) {
      researchInterests.value = result.generatedProfile;
      alert('Research profile generated successfully!');
      console.log('Generated research profile:', result.generatedProfile);
    } else {
      alert('Profile generated but no content returned');
    }
    
  } catch (error) {
    console.error('Error generating research profile:', error);
    alert('Error generating research profile: ' + error.message);
  } finally {
    // Reset button state
    generateBtn.disabled = false;
    generateBtnText.style.display = 'inline';
    generateBtnLoading.style.display = 'none';
  }
  } catch (outerError) {
    console.error('Outer error in generateResearchProfile:', outerError);
    alert('Unexpected error: ' + outerError.message);
  }
}

// Backend status check function removed - not needed for simplified onboarding



function saveSettings() {
  return new Promise((resolve, reject) => {
    try {
      // Get Essence Scholar API key
      const essenceScholarApiKey = document.getElementById('essenceApiKey')?.value.trim() || '';
      
      // Get selected model
      const selectedModelCard = document.querySelector('.model-card.selected');
      const selectedModel = selectedModelCard ? selectedModelCard.dataset.model : 'gemini-3-flash-preview';
      
      // Get research profile
      const googleScholarUrl = document.getElementById('googleScholarUrl').value.trim();
      const researchInterests = document.getElementById('researchInterests').value.trim();
      
      // Get analysis preferences
      const juniorResearchers = {};
      document.querySelectorAll('input[name="junior_researchers"]:checked').forEach(checkbox => {
        juniorResearchers[checkbox.value] = true;
      });
      
      // Prepare settings objects
      const llmSettings = {
        model: selectedModel
        // API keys removed - backend handles all API key management
      };
      
      const userSettings = {
        googleScholarUrl: googleScholarUrl,
        researchInterests: researchInterests
      };
      
      // Save to chrome.storage
      chrome.storage.local.set({
        essenceScholarApiKey: essenceScholarApiKey,
        llmSettings: llmSettings,
        userSettings: userSettings,
        juniorResearchers: juniorResearchers,
        onboardingCompleted: true
      }, function() {
        if (chrome.runtime.lastError) {
          reject(chrome.runtime.lastError);
        } else {
          resolve();
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}

function finishSetup() {
  const finishBtn = document.getElementById('finishBtn');
  const finishBtnText = document.getElementById('finishBtnText');
  const finishBtnLoading = document.getElementById('finishBtnLoading');
  
  // Show loading state
  finishBtn.disabled = true;
  finishBtnText.style.display = 'none';
  finishBtnLoading.style.display = 'inline-block';
  
  saveSettings()
    .then(() => {
      // Show success message
      showSuccessMessage();
      
      // Redirect to fullpage after a delay
      setTimeout(() => {
        window.location.href = chrome.runtime.getURL('fullpage.html');
      }, 2000);
    })
    .catch(error => {
      console.error('Error saving settings:', error);
      alert('There was an error saving your settings. Please try again.');
      
      // Reset button state
      finishBtn.disabled = false;
      finishBtnText.style.display = 'inline';
      finishBtnLoading.style.display = 'none';
    });
}

function skipSetup() {
  // Set default settings
  const defaultSettings = {
    essenceScholarApiKey: '', // Add API key field
    llmSettings: {
      model: 'gemini-3-flash-preview'
      // Old API key fields removed - no longer needed
    },
    userSettings: {
      googleScholarUrl: '',
      researchInterests: ''
    },
    juniorResearchers: {
      key_message: false,
      author_profiles: false,
      contributions_novelty: false,
      data_variables_models: false,
      identification_causality: false,
      quick_takeaways: false,
      bibliography_reference: false
    },
    onboardingCompleted: true
  };
  
  chrome.storage.local.set(defaultSettings, function() {
    if (chrome.runtime.lastError) {
      console.error('Error saving default settings:', chrome.runtime.lastError);
    }
    window.location.href = chrome.runtime.getURL('fullpage.html');
  });
}

function showSuccessMessage() {
  const container = document.querySelector('.onboarding-container');
  container.innerHTML = `
    <div class="onboarding-header">
      <h1 class="onboarding-title">🎉 Setup Complete!</h1>
      <p class="onboarding-subtitle">You're all set to start using Essence Scholar</p>
      <p class="onboarding-description">
        Your preferences have been saved. You can now analyze papers and get personalized insights!
      </p>
    </div>
    <div style="text-align: center; margin-top: 40px;">
      <div style="font-size: 64px; margin-bottom: 20px;">✓</div>
      <p style="font-size: 18px; color: #28a745;">Redirecting you to the main interface...</p>
    </div>
  `;
}

// API Key validation and testing functions
function validateEssenceApiKey() {
  console.log('validateEssenceApiKey called');
  const apiKeyInput = document.getElementById('essenceApiKey');
  const testBtn = document.getElementById('testApiKeyBtn');
  const statusDiv = document.getElementById('apiKeyStatus');
  
  console.log('Elements found:', { apiKeyInput: !!apiKeyInput, testBtn: !!testBtn, statusDiv: !!statusDiv });
  
  if (!apiKeyInput) {
    console.error('API key input element not found');
    return true; // Skip if element doesn't exist
  }
  
  const apiKey = apiKeyInput.value.trim();
  console.log('API key value:', apiKey ? `${apiKey.substring(0, 10)}...` : 'empty');
  
  // Check format: sk_live_{prefix}_{32hex}
  const apiKeyRegex = /^sk_live_[a-z0-9]{4}_[a-f0-9]{32}$/;
  
  if (!apiKey) {
    showApiKeyStatus('Please enter your Essence Scholar API key to continue.', 'error');
    return false;
  }
  
  if (!apiKeyRegex.test(apiKey)) {
    showApiKeyStatus('Invalid API key format. Should be: sk_live_xxxx_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 'error');
    return false;
  }
  
  // Show test button and success status
  if (testBtn) testBtn.style.display = 'inline-block';
  showApiKeyStatus('✓ Valid API key format. Click "Test API Key" to verify it works.', 'success');
  return true;
}

function testEssenceApiKey() {
  const apiKeyInput = document.getElementById('essenceApiKey');
  const testBtn = document.getElementById('testApiKeyBtn');
  const testBtnText = document.getElementById('testBtnText');
  const testBtnLoading = document.getElementById('testBtnLoading');
  
  if (!apiKeyInput || !testBtn) return;
  
  const apiKey = apiKeyInput.value.trim();
  
  // Show loading state
  testBtn.disabled = true;
  testBtnText.style.display = 'none';
  testBtnLoading.style.display = 'inline-block';
  
  // Test the API key by calling the profile endpoint
  getBackendUrl().then(backendUrl => {
    fetch(`${backendUrl}/auth/profile`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      }
    })
    .then(response => {
      if (response.ok) {
        return response.json();
      } else if (response.status === 401) {
        throw new Error('Invalid API key');
      } else if (response.status === 402) {
        throw new Error('Insufficient credits');
      } else {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
    })
    .then(data => {
      showApiKeyStatus(`✓ API key verified! Welcome, ${data.user.name || data.user.email}. You have ${data.user.credits} credits remaining.`, 'success');
      
      // Store the API key in Chrome storage
      chrome.storage.sync.set({
        'essence_scholar_api_key': apiKey,
        'essence_scholar_user': data.user
      }, () => {
        console.log('API key saved to Chrome storage');
      });
    })
    .catch(error => {
      showApiKeyStatus(`X API key test failed: ${error.message}`, 'error');
    })
    .finally(() => {
      // Reset button state
      testBtn.disabled = false;
      testBtnText.style.display = 'inline';
      testBtnLoading.style.display = 'none';
    });
  }).catch(error => {
    showApiKeyStatus(`X Backend detection failed: ${error.message}`, 'error');
    // Reset button state on backend error
    testBtn.disabled = false;
    testBtnText.style.display = 'inline';
    testBtnLoading.style.display = 'none';
  });
}

function showApiKeyStatus(message, type) {
  const statusDiv = document.getElementById('apiKeyStatus');
  if (!statusDiv) return;
  
  statusDiv.textContent = message;
  statusDiv.className = `api-key-status ${type}`;
  statusDiv.style.display = 'block';
}

// Handle window close
window.addEventListener('beforeunload', function() {
  // Mark onboarding as completed even if user closes window
  chrome.storage.local.set({ onboardingCompleted: true });
});

// Test function - call this from console to test
window.testGenerateProfile = function() {
      console.log('Testing generate profile function...');
  generateResearchProfile();
}; 