// ============================================================================
// SITE CONFIGURATION
// Minimal JS - only essential dynamic content
// ============================================================================

// Update copyright year automatically
function updateCopyrightYear() {
  const yearSpan = document.querySelector('#year');
  if (yearSpan) yearSpan.textContent = new Date().getFullYear();
}

// Run on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', updateCopyrightYear);
} else {
  updateCopyrightYear();
}
