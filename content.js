// ============================================================================
// SITE CONFIGURATION
// Minimal JS - keep design in HTML/CSS
// ============================================================================

const SITE_CONFIG = {
  siteTitle: "Audio Design Studios",
  contactEmail: "music@kartergbrown.com",
  copyright: "Audio Design Studios. All rights reserved.",
  
  navigation: {
    home: "Home",
    portfolio: "Portfolio",
    about: "About",
    music: "Music"
  }
};

// ============================================================================
// INITIALIZE SITE
// ============================================================================

function init() {
  // Update logo
  const logo = document.querySelector('.logo');
  if (logo) logo.textContent = SITE_CONFIG.siteTitle;
  
  // Update navigation
  const navLinks = document.querySelectorAll('.nav a');
  const navItems = [
    SITE_CONFIG.navigation.home,
    SITE_CONFIG.navigation.portfolio,
    SITE_CONFIG.navigation.about,
    SITE_CONFIG.navigation.music
  ];
  navLinks.forEach((link, i) => {
    if (link && navItems[i]) link.textContent = navItems[i];
  });
  
  // Update footer email
  const footerEmail = document.querySelector('.site-footer a[href^="mailto"]');
  if (footerEmail) {
    footerEmail.href = `mailto:${SITE_CONFIG.contactEmail}`;
    footerEmail.textContent = SITE_CONFIG.contactEmail;
  }
  
  // Update copyright year
  const yearSpan = document.querySelector('#year');
  if (yearSpan) yearSpan.textContent = new Date().getFullYear();
}

// Run on page load
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
